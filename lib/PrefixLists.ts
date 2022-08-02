// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { aws_iam as iam, custom_resources as cr } from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

export class ManagedPrefixLists extends Construct {
  public readonly ManagedPrefixLists: cr.AwsCustomResource;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const prefixListsLambdaRole = new iam.Role(
      this,
      "Managed Prefix Lists Lambda Role",
      {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        path: "/",
        inlinePolicies: {
          CloudWatchLogsPolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents",
                ],
                resources: [
                  cdk.Stack.of(this).formatArn({
                    service: "logs",
                    resource: "log-group",
                    resourceName: "/aws/lambda/*",
                    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                  }),
                ],
              }),
            ],
          }),
        },
      }
    );

    this.ManagedPrefixLists = new cr.AwsCustomResource(
      this,
      "ManagedPrefixLists",
      {
        resourceType: "Custom::GetPrefixListIds",
        onUpdate: {
          region: cdk.Aws.REGION,
          service: "EC2",
          action: "describeManagedPrefixLists",
          parameters: {
            Filters: [
              {
                Name: "prefix-list-name",
                Values: [
                  "com.amazonaws." + cdk.Aws.REGION + ".dynamodb",
                  "com.amazonaws." + cdk.Aws.REGION + ".s3",
                ],
              },
            ],
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            "DescribeManagedPrefixListIdsFunction"
          ),
        },
        role: prefixListsLambdaRole,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      }
    );

    NagSuppressions.addResourceSuppressionsByPath(
      cdk.Stack.of(this),
      "/AwsBackupActionsStack/AWS679f53fac002430cb0da5b7982bd2287/Resource",
      [
        {
          id: "AwsSolutions-L1",
          reason:
            "The AwsCustomResource Construct manages the Lambda and does not expose the runtime version. Keep aws-cdk-lib up to date to keep the runtime version up to date.",
        },
      ]
    );

    NagSuppressions.addResourceSuppressions(
      this.ManagedPrefixLists,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "ec2:DescribeManagedPrefixLists doesn't accept resources",
        },
      ],
      true
    );
  }
}
