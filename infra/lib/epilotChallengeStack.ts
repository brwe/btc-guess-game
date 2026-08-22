import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  DockerImage,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ecr_assets as ecrAssets,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_logs as logs,
  aws_rds as rds,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export class EpilotChallengeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const vpc = new ec2.Vpc(this, "Vpc", {
      availabilityZones: [`${this.region}a`, `${this.region}b`],
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "database",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    const database = new rds.DatabaseInstance(this, "Database", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: new ec2.InstanceType("t4g.micro"),
      credentials: rds.Credentials.fromGeneratedSecret("epilot"),
      databaseName: "epilot",
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: Duration.days(1),
      deletionProtection: false,
      deleteAutomatedBackups: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    if (!database.secret) throw new Error("RDS credentials secret was not created");

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(this, "BackendTask", {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    const backendImage = new ecrAssets.DockerImageAsset(this, "BackendImage", {
      directory: path.join(projectRoot, "backend"),
      platform: ecrAssets.Platform.LINUX_AMD64,
    });
    const logGroup = new logs.LogGroup(this, "BackendLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const backend = taskDefinition.addContainer("Backend", {
      image: ecs.ContainerImage.fromDockerImageAsset(backendImage),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "backend" }),
      environment: {
        HOST: "0.0.0.0",
        PORT: "3001",
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: database.dbInstanceEndpointPort,
        DB_NAME: "epilot",
        GUESS_DURATION_SECONDS: "60",
        COINBASE_WEBSOCKET_URL: "wss://ws-feed.exchange.coinbase.com",
        RESET_DATABASE_ON_START: "false",
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(database.secret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret, "password"),
      },
    });
    backend.addPortMappings({ containerPort: 3001 });

    const service = new ecs.FargateService(this, "BackendService", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    database.connections.allowDefaultPortFrom(service);

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    const listener = loadBalancer.addListener("Http", {
      port: 80,
      open: true,
    });
    listener.addTargets("Backend", {
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: Duration.seconds(10),
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200",
      },
    });

    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      additionalBehaviors: {
        "api/*": {
          origin: new origins.LoadBalancerV2Origin(loadBalancer, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: "/index.html",
        ttl: Duration.seconds(0),
      })),
    });

    new s3deploy.BucketDeployment(this, "FrontendDeployment", {
      destinationBucket: frontendBucket,
      sources: [
        s3deploy.Source.asset(path.join(projectRoot, "frontend"), {
          bundling: {
            image: DockerImage.fromRegistry("oven/bun:1.3.9"),
            command: [
              "sh",
              "-c",
              [
                "cp -R /asset-input/. /tmp/frontend",
                "cd /tmp/frontend",
                "bun install",
                "bun run build",
                "cp -R dist/. /asset-output/",
              ].join(" && "),
            ],
          },
        }),
      ],
      distribution,
      distributionPaths: ["/*"],
    });

    new CfnOutput(this, "ApplicationUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "DatabaseSecretArn", {
      value: database.secret.secretArn,
    });
  }
}
