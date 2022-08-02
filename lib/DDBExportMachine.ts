// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  aws_iam as iam,
  aws_s3 as s3,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

import { BaseStateMachine } from "./BaseStateMachine";

export interface DDBExportMachineProps {
  bucket: s3.Bucket;
}

export class DDBExportMachine extends Construct {
  public readonly ddbmachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: DDBExportMachineProps) {
    super(scope, id);

    const DDBStartExportTask = new tasks.CallAwsService(
      this,
      "DDBStartExportTask",
      {
        service: "dynamodb",
        action: "exportTableToPointInTime",
        iamResources: [
          `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/*`,
        ],
        parameters: {
          "TableArn.$": "$.ResourceArn",
          "ExportTime.$": "$.CreationDate",
          ExportFormat: "DYNAMODB_JSON",
          "S3Bucket.$": "$.S3BucketName",
          "S3Prefix.$": "$.S3Prefix",
          S3SseAlgorithm: "KMS",
          S3SseKmsKeyId: props.bucket.encryptionKey!.keyArn,
        },
        resultPath: "$.Export",
        resultSelector: { "ExportArn.$": "$.ExportDescription.ExportArn" },
      }
    ).addRetry();

    const DDBExportStatusTask = new tasks.CallAwsService(
      this,
      "DDBExportStatusTask",
      {
        service: "dynamodb",
        action: "describeExport",
        iamResources: ["*"],
        parameters: {
          "ExportArn.$": "$.Export.ExportArn",
        },
        resultSelector: {
          "ExportStatus.$": "$.ExportDescription.ExportStatus",
        },
        resultPath: "$.Status",
      }
    );

    const DDBExportWait = new sfn.Wait(this, "DDBExportWait", {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(30)),
    }).next(DDBExportStatusTask);

    const DDBExportStatus = new sfn.Choice(this, "DDBExportStatus")
      .when(
        sfn.Condition.stringEquals("$.Status.ExportStatus", "COMPLETED"),
        new sfn.Succeed(this, "DDBExportSucceed")
      )
      .when(
        sfn.Condition.stringEquals("$.Status.ExportStatus", "IN_PROGRESS"),
        DDBExportWait
      )
      .otherwise(new sfn.Fail(this, "DDBExportFailed"));

    this.ddbmachine = new BaseStateMachine(this, "DDB Export Machine", {
      definition: DDBStartExportTask.next(
        DDBExportStatusTask.next(DDBExportStatus)
      ),
    }).statemachine;

    props.bucket.grantWrite(this.ddbmachine.role);

    props.bucket.encryptionKey!.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey*",
          "kms:ReEncrypt*",
          "kms:CreateGrant",
          "kms:DescribeKey",
          "kms:RetireGrant",
        ],
        principals: [this.ddbmachine.role],
        resources: ["*"],
      }),
      true
    );

    const DDBRoleOutput = new cdk.CfnOutput(this, "DDBKMSRole", {
      value: this.ddbmachine.role.roleArn,
      description: "This role must be granted access to the KMS CMK.",
    });

    NagSuppressions.addResourceSuppressions(
      this.ddbmachine.role,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "dynamodb:describeExportTasks does not support Resource permissions. " +
            "dynamodb:exportTableToPointInTime is restricted with a prefixed Resource. " +
            "KMS and S3 wildcards allow access to a specific bucket using CDK's methods.",
        },
      ],
      true
    );
  }
}
