// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_s3 as s3,
  aws_iam as iam,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as batch from "@aws-cdk/aws-batch-alpha";
import * as path from "path";
import { NagSuppressions } from "cdk-nag";

import { BaseStateMachine } from "./BaseStateMachine";

export interface EBSBackupMachineProps {
  tags: Record<string, string>;
  securityTag?: string;
  tagcondition: Record<string, Record<string, string>>;
  jqs: Record<string, batch.JobQueue>;
  bucket: s3.Bucket;
  batchsg: ec2.SecurityGroup;
  vpc: ec2.Vpc;
}

export class EBSBackupMachine extends Construct {
  public readonly ebsmachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: EBSBackupMachineProps) {
    super(scope, id);

    // EBS
    const ebsjobrole = new iam.Role(this, "EBSBackupJobRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      inlinePolicies: {
        ebspolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: ["*"],
              actions: ["ec2:DescribeVolumes"],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:volume/*`,
                `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/*`,
              ],
              actions: [
                "ec2:AttachVolume",
                "ec2:DetachVolume",
                "ec2:DeleteVolume",
              ],
              conditions: props.tagcondition,
            }),
          ],
        }),
      },
    });

    props.bucket.grantWrite(ebsjobrole);
    props.bucket.encryptionKey!.grant(
      ebsjobrole,
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
        principals: [ebsjobrole],
        resources: ["*"],
      }),
      true
    );

    NagSuppressions.addResourceSuppressions(
      ebsjobrole,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "ec2:DescribeVolumes and ecr:GetAuthorizationToken do not support Resource permissions. " +
            "Permissions to Attach, Detach, and Delete EBS volumes are restricted by a tag condition. " +
            "KMS and S3 wildcards allow access to a specific bucket using CDK's grantWrite method.",
        },
      ],
      true
    );

    const EBSRoleOutput = new cdk.CfnOutput(this, "EBSKMSRole", {
      value: ebsjobrole.roleArn,
      description: "This role must be granted access to the KMS CMK.",
    });

    const vpcendpointsg = new ec2.SecurityGroup(
      this,
      "VPCEndpointSecurityGroup",
      {
        vpc: props.vpc,
        allowAllOutbound: false,
        description: "Allow EBS batch jobs to call EC2 APIs",
      }
    );

    props.vpc.addInterfaceEndpoint("Ec2Endpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.EC2,
      securityGroups: [vpcendpointsg],
      open: false,
    });

    vpcendpointsg.connections.allowFrom(props.batchsg, ec2.Port.tcp(443));

    // EBS job definition
    const ebsjobdef = new batch.JobDefinition(this, "EBSBackupJobDef", {
      container: {
        image: ecs.ContainerImage.fromAsset(
          path.join(__dirname, "..", "containers", "EBSbackup")
        ),
        vcpus: 1,
        memoryLimitMiB: 2048,
        command: ["Ref::volume", "Ref::s3path"],
        environment: {
          IROOT: "/iroot",
          AWS_DEFAULT_REGION: process.env.CDK_DEFAULT_REGION as string,
        },
        jobRole: ebsjobrole,
        volumes: [
          {
            name: "root",
            host: { sourcePath: "/" },
          },
        ],
        mountPoints: [
          {
            containerPath: "/iroot",
            sourceVolume: "root",
            readOnly: false,
          },
        ],
        privileged: true,
        user: "root",
      },
    });

    const EBSWaitDetach = new sfn.Wait(this, "EBSWaitDetach", {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(2)),
    });

    // TODO: add an iamCondition parameter to CDK and restrict to props.tagcondition. temporarily allowing to a dummy arn and adding the tag policy manually.
    const EBSForceDetach = new tasks.CallAwsService(this, "EBSForceDetach", {
      service: "ec2",
      action: "detachVolume",
      iamResources: [
        `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:null`,
      ],
      parameters: {
        "VolumeId.$": "$.Restore.VolumeId",
      },
      resultPath: "$.DetachVolume",
    });

    // TODO: add an iamCondition parameter to CDK and restrict to props.tagcondition. temporarily allowing to a dummy arn and adding the tag policy manually.
    const EBSCleanupTask = new tasks.CallAwsService(this, "EBSCleanupTask", {
      service: "ec2",
      action: "deleteVolume",
      iamResources: [
        `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:null`,
      ],
      parameters: {
        "VolumeId.$": "$.Restore.VolumeId",
      },
      resultPath: "$.DeleteVolume",
    });

    EBSCleanupTask.addCatch(EBSForceDetach, {
      errors: ["VolumeInUse"],
    }).addRetry();
    EBSForceDetach.next(EBSWaitDetach);
    EBSWaitDetach.next(EBSCleanupTask);

    EBSCleanupTask.next(
      new sfn.Choice(this, "EBSCleanupResult")
        .when(
          sfn.Condition.isNotPresent("$.Error"),
          new sfn.Succeed(this, "EBSSucceed")
        )
        .when(sfn.Condition.isPresent("$.Error"), new sfn.Fail(this, "EBSFail"))
    );

    const voltags = Object.entries(props.tags).map(([key, value]) => {
      return { Key: key, Value: value };
    });

    const EBSRestoreTask = new tasks.CallAwsService(this, "EBSRestoreTask", {
      service: "ec2",
      action: "createVolume",
      iamResources: [`arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
      parameters: {
        "AvailabilityZone.$": "$.AvailabilityZone",
        "SnapshotId.$": "$.SnapshotId",
        VolumeType: "gp3",
        TagSpecifications: [
          {
            ResourceType: "volume",
            Tags: voltags,
          },
        ],
      },
      resultPath: "$.Restore",
      resultSelector: { "VolumeId.$": "$.VolumeId" },
    }).addRetry();

    const EBSReadyTask = new tasks.CallAwsService(this, "EBSReadyTask", {
      service: "ec2",
      action: "describeVolumes",
      iamResources: ["*"],
      parameters: {
        "VolumeIds.$": "States.Array($.Restore.VolumeId)",
      },
      resultPath: "$.Ready",
      resultSelector: {
        "State.$": "$.Volumes[0].State",
      },
    }).addCatch(EBSCleanupTask);

    const EBSReadyWait = new sfn.Wait(this, "EBSReadyWait", {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(1)),
    }).next(EBSReadyTask);

    const ebsbatchtasks: Record<string, tasks.BatchSubmitJob> = {};
    Object.entries(props.jqs).forEach(([az, jq]) => {
      const jobtask = new tasks.BatchSubmitJob(
        this,
        `EBSBatchJobTask${az.slice(-1)}`,
        {
          jobDefinitionArn: ebsjobdef.jobDefinitionArn,
          jobName: `EBSBackupJob${az.slice(-1)}`,
          attempts: 2,
          jobQueueArn: jq.jobQueueArn,
          resultSelector: { "Status.$": "$.Status" },
          resultPath: "$.JobResult",
          payload: sfn.TaskInput.fromObject({
            "volume.$": "$.Restore.VolumeId",
            "s3path.$":
              "States.Format('s3://{}/{}', $.S3BucketName, $.S3Prefix)",
          }),
        }
      );
      jobtask.addCatch(EBSCleanupTask, { resultPath: "$.Error" });
      ebsbatchtasks[az] = jobtask;
    });

    let ebsreadychoice = new sfn.Choice(this, "EBS Ready?");

    Object.entries(ebsbatchtasks).forEach(([az, task]) => {
      ebsreadychoice = ebsreadychoice.when(
        sfn.Condition.and(
          sfn.Condition.stringEquals("$.Ready.State", "available"),
          sfn.Condition.stringEquals("$.AvailabilityZone", az)
        ),
        task.next(EBSCleanupTask)
      );
    });

    ebsreadychoice
      .when(
        sfn.Condition.stringEquals("$.Ready.State", "creating"),
        EBSReadyWait
      )
      .otherwise(new sfn.Fail(this, "EBSReadyFailed"));

    ebsreadychoice.afterwards();

    const ebsdefinition =
      EBSRestoreTask.next(EBSReadyTask).next(ebsreadychoice);

    this.ebsmachine = new BaseStateMachine(this, "EBS Backup Machine", {
      definition: ebsdefinition,
    }).statemachine;

    this.ebsmachine.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [
          `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:volume/*`,
        ],
        actions: ["ec2:CreateTags"],
      })
    );

    this.ebsmachine.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [
          `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:volume/*`,
        ],
        actions: ["ec2:DetachVolume", "ec2:DeleteVolume"],
        conditions: props.tagcondition,
      })
    );

    NagSuppressions.addResourceSuppressions(
      this.ebsmachine.role,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "ec2:DescribeVolumes does not support Resource permissions. " +
            "ec2:CreateVolume and batch operations are restricted to the account and region with a wildcard prefix. " +
            "Needs to be able to tag EBS volumes that it creates from snapshots to restrict Detach and Delete permissions. " +
            "Permissions to Detach, and Delete EBS volumes are restricted by a tag condition. " +
            "KMS and S3 wildcards allow access to a specific bucket using CDK's grantWrite method.",
        },
      ],
      true
    );
  }
}
