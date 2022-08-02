// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  aws_s3 as s3,
  aws_iam as iam,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

import { BaseStateMachine } from "./BaseStateMachine";

export interface RDSExportMachineProps {
  bucket: s3.Bucket;
}

export class RDSExportMachine extends Construct {
  public readonly rdsmachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: RDSExportMachineProps) {
    super(scope, id);

    const rdsexportrole = new iam.Role(this, "RDSExportRole", {
      assumedBy: new iam.ServicePrincipal("export.rds.amazonaws.com"),
    });

    props.bucket.grantReadWrite(rdsexportrole);
    props.bucket.encryptionKey!.grant(
      rdsexportrole,
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
      "kms:CreateGrant",
      "kms:DescribeKey",
      "kms:RetireGrant"
    );

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
        principals: [rdsexportrole],
        resources: ["*"],
      }),
      true
    );

    NagSuppressions.addResourceSuppressions(
      rdsexportrole,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "KMS and S3 wildcards are the minimum permissions to call rds:startExportTask",
        },
      ],
      true
    );

    const RDSRoleOutput = new cdk.CfnOutput(this, "RDSKMSRole", {
      value: rdsexportrole.roleArn,
      description: "This role must be granted access to the KMS CMK.",
    });

    const RDSStartExportTask = new tasks.CallAwsService(
      this,
      "RDSStartExportTask",
      {
        service: "rds",
        action: "startExportTask",
        iamResources: ["*"],
        parameters: {
          "ExportTaskIdentifier.$":
            "States.Format('acb-{}', $$.Execution.Name)",
          "SourceArn.$": "$.SnapshotArn",
          IamRoleArn: rdsexportrole.roleArn,
          KmsKeyId: props.bucket.encryptionKey
            ? props.bucket.encryptionKey.keyArn
            : "aws/s3",
          "S3BucketName.$": "$.S3BucketName",
          "S3Prefix.$": "$.S3Prefix",
        },
        resultSelector: { "ExportTaskIdentifier.$": "$.ExportTaskIdentifier" },
        resultPath: "$.Export",
      }
    );

    const RDSExportStatusTask = new tasks.CallAwsService(
      this,
      "RDSExportStatusTask",
      {
        service: "rds",
        action: "describeExportTasks",
        iamResources: ["*"],
        parameters: {
          "ExportTaskIdentifier.$": "$.Export.ExportTaskIdentifier",
        },
        resultSelector: {
          "ExportStatus.$": "$.ExportTasks[0].Status",
        },
        resultPath: "$.Status",
      }
    );

    const RDSExportWait = new sfn.Wait(this, "RDSExportWait", {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(30)),
    }).next(RDSExportStatusTask);

    const RDSExportStatus = new sfn.Choice(this, "RDSExportStatus")
      .when(
        sfn.Condition.stringEquals("$.Status.ExportStatus", "COMPLETE"),
        new sfn.Succeed(this, "RDSExportSucceed")
      )
      .when(
        sfn.Condition.or(
          sfn.Condition.stringEquals("$.Status.ExportStatus", "FAILED"),
          sfn.Condition.stringEquals("$.Status.ExportStatus", "CANCELED")
        ),
        new sfn.Fail(this, "RDSExportFailed")
      )
      .otherwise(RDSExportWait);

    this.rdsmachine = new BaseStateMachine(this, "RDS Export Machine", {
      definition: RDSStartExportTask.next(
        RDSExportStatusTask.next(RDSExportStatus)
      ),
    }).statemachine;

    props.bucket.encryptionKey!.grant(
      this.rdsmachine.role,
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
      "kms:CreateGrant",
      "kms:DescribeKey",
      "kms:RetireGrant"
    );

    this.rdsmachine.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [rdsexportrole.roleArn],
        actions: ["iam:PassRole"],
      })
    );

    NagSuppressions.addResourceSuppressions(
      this.rdsmachine.role,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "rds:startExportTask and rds:describeExportTasks do not support Resource permissions. " +
            "KMS and S3 wildcards allow access to a specific bucket using CDK's grantWrite method.",
        },
      ],
      true
    );
  }
}
