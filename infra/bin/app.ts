#!/usr/bin/env bun
import { App } from "aws-cdk-lib";
import { BtcGuessGameStack } from "../lib/btcGuessGameStack";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? "eu-central-1";

if (account) {
  app.node.setContext(
    `availability-zones:account=${account}:region=${region}`,
    [`${region}a`, `${region}b`],
  );
}

new BtcGuessGameStack(app, "BtcGuessGameStack", {
  env: {
    account,
    region,
  },
  description: "BTC guessing game: CloudFront, S3, ECS Fargate, ALB, and RDS PostgreSQL",
});
