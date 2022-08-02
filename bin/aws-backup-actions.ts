#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AwsBackupActionsStack } from "../lib/aws-backup-actions-stack";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";

const app = new cdk.App();
const stack = new AwsBackupActionsStack(app, "AwsBackupActionsStack", {
  env: {
    account: app.node.tryGetContext("account"),
    region: app.node.tryGetContext("region"),
  },
});
cdk.Aspects.of(app).add(
  new AwsSolutionsChecks({
    verbose: true,
  })
);

NagSuppressions.addStackSuppressions(
  stack,
  [
    {
      id: "AwsSolutions-IAM5",
      reason: "Allow to Lambdas write to Cloudwatch Log Group under prefix",
      appliesTo: [
        {
          regex:
            "/^Resource::arn:<AWS::Partition>:logs:(.*):log-group:/aws/lambda/\\*/g",
        },
      ],
    },
  ],
  true
);
