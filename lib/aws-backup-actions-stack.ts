// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  aws_ec2 as ec2,
  aws_s3 as s3,
  aws_kms as kms,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
  aws_events as events,
  aws_events_targets as targets,
  aws_sns as sns,
} from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import { NagSuppressions } from "cdk-nag";

import { BatchCE } from "./BatchCE";
import { EBSBackupMachine } from "./EBSBackupMachine";
import { RDSExportMachine } from "./RDSExportMachine";
import { DDBExportMachine } from "./DDBExportMachine";
import { BaseStateMachine } from "./BaseStateMachine";

interface ILifecycleRulesContext {
  glacier?: number;
  deepArchive?: number;
  expiration?: number;
}

export class AwsBackupActionsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get context
    const tags: Record<string, string> = this.node.tryGetContext("tags");
    const securityTag: string = this.node.tryGetContext("securityTag");
    const backupTag: string = this.node.tryGetContext("backupTag");
    const s3KmsCmk: string | undefined = this.node.tryGetContext("s3KmsCmk");
    const s3AccessLogsBucket: string | undefined =
      this.node.tryGetContext("s3AccessLogsBucket");
    const s3AccessLogsPrefix: string | undefined =
      this.node.tryGetContext("s3AccessLogsPrefix");

    const autoDeleteSnapshot: boolean =
      Boolean(this.node.tryGetContext("auto-delete-snapshot")) || false;
    const notificationAlias: string | undefined =
      this.node.tryGetContext("notificationAlias");

    const lifecycleRulesContext: ILifecycleRulesContext | undefined =
      this.node.tryGetContext("lifecycleRules");

    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value as string);
    });

    const bucketEncryption = s3.BucketEncryption.KMS;
    const bucketEncryptionKey = s3KmsCmk
      ? kms.Key.fromKeyArn(this, "BackupBucketKey", s3KmsCmk)
      : new kms.Key(this, "BackupBucketKey", {
          enableKeyRotation: true,
          admins: [new iam.AccountRootPrincipal()],
          policy: new iam.PolicyDocument(),
        });

    new cdk.CfnOutput(this, "KMS CMK", {
      value: bucketEncryptionKey.keyId,
      description: "Add the role ARNs to this KMS CMK.",
    });

    // Create a Bucket to store the backups
    const bucket = new s3.Bucket(this, "BackupBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: bucketEncryption,
      encryptionKey: bucketEncryptionKey,
      enforceSSL: true,
      autoDeleteObjects: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsBucket: s3AccessLogsBucket
        ? s3.Bucket.fromBucketName(this, "AccessLogsBucket", s3AccessLogsBucket)
        : undefined,
      serverAccessLogsPrefix: s3AccessLogsPrefix
        ? s3AccessLogsPrefix
        : undefined,
    });

    if (lifecycleRulesContext) {
      bucket.addLifecycleRule({
        enabled: true,
        expiration:
          lifecycleRulesContext &&
          lifecycleRulesContext.expiration &&
          lifecycleRulesContext.expiration > 0
            ? cdk.Duration.days(lifecycleRulesContext.expiration)
            : undefined,
        transitions: [
          ...(lifecycleRulesContext &&
          lifecycleRulesContext.glacier &&
          lifecycleRulesContext.glacier > 0
            ? [
                {
                  storageClass: s3.StorageClass.GLACIER,
                  transitionAfter: cdk.Duration.days(
                    lifecycleRulesContext.glacier
                  ),
                },
              ]
            : []),
          ...(lifecycleRulesContext &&
          lifecycleRulesContext.deepArchive &&
          lifecycleRulesContext.deepArchive > 0
            ? [
                {
                  storageClass: s3.StorageClass.DEEP_ARCHIVE,
                  transitionAfter: cdk.Duration.days(
                    lifecycleRulesContext.deepArchive
                  ),
                },
              ]
            : []),
        ],
      });
    }

    // Create a new VPC with isolated subnets and endpoints for S3, DynamoDB
    const vpc = new ec2.Vpc(this, "ColdBackupVPC", {
      maxAzs: 3,
      subnetConfiguration: [
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 22,
        },
      ],
      gatewayEndpoints: {
        DynamoDB: {
          service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        },
      },
    });

    const s3GatewayEndpoint = vpc.addGatewayEndpoint("S3GatewayEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    s3GatewayEndpoint.addToPolicy(
      new iam.PolicyStatement({
        sid: "BackupBucketWriteOnly",
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:DeleteObject*",
          "s3:PutObject",
          "s3:PutObjectLegalHold",
          "s3:PutObjectRetention",
          "s3:PutObjectTagging",
          "s3:PutObjectVersionTagging",
          "s3:Abort*",
        ],
        resources: [`${bucket.bucketArn}/*`],
        principals: [new iam.StarPrincipal()],
      })
    );

    s3GatewayEndpoint.addToPolicy(
      new iam.PolicyStatement({
        sid: "ECRDownloadImages",
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [
          `arn:aws:s3:::prod-${cdk.Aws.REGION}-starport-layer-bucket/*`,
        ],
        principals: [new iam.StarPrincipal()],
      })
    );

    const flowloggroup = new logs.LogGroup(this, "ColdBackupFlowLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const flowlogrole = new iam.Role(this, "FlowLogRole", {
      assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
    });

    vpc.addFlowLog("ColdBackupVPCFlowLog", {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        flowloggroup,
        flowlogrole
      ),
    });
    //    NagSuppressions.addResourceSuppressions(flowlogrole,
    //      [{id: "AwsSolutions-IAM5", reason: "CDK's KMS grantEncryptDecrypt includes kms:ReEncrypt* and kms:GenerateDataKey*"}], true);

    const batchce = new BatchCE(this, "BatchComputeEnvironments", {
      vpc: vpc,
      tags: tags,
    });

    let tagcondition: Record<string, Record<string, string>> = {};
    if (securityTag) {
      tagcondition = { StringEquals: {} };
      tagcondition["StringEquals"][`ec2:ResourceTag/${securityTag}`] =
        tags[securityTag];
    }

    // EBS
    const ebsbackupmachine = new EBSBackupMachine(this, "EBS Backup Machine", {
      tags: tags,
      tagcondition: tagcondition,
      jqs: batchce.jqs,
      bucket: bucket,
      batchsg: batchce.cesg,
      vpc: vpc,
    });

    // RDS
    const rdsexportmachine = new RDSExportMachine(this, "RDS Export Machine", {
      bucket: bucket,
    });

    // DDB
    const ddbexportmachine = new DDBExportMachine(this, "DDB Export Machine", {
      bucket: bucket,
    });

    // Outer statemachine

    const metadataLambdaRole = new iam.Role(this, "Metadata Lambda Role", {
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
        BackupMetadataPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: ["*"],
              actions: [
                "ec2:DescribeTags",
                "rds:ListTagsForResource",
                "dynamodb:ListTagsOfResource",
                "s3:ListAllMyBuckets",
                "s3:ListBucket",
              ],
            }),
          ],
        }),
      },
    });

    NagSuppressions.addResourceSuppressions(metadataLambdaRole, [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "The metadata Lambda needs to list tags for any resources in the account and to list buckets to prevent bucket sniping",
      },
    ]);

    // Snapshot metadata lambda
    // Return Snapshot metadata and a random AZ
    const metadataLambda = new lambda.Function(this, "snapshot-metadata", {
      handler: "snapshotMetadata.metadataHandler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "functions", "snapshotMetadata")
      ),
      runtime: lambda.Runtime.NODEJS_16_X,
      description: "Get snapshot metadata and a random AZ",
      role: metadataLambdaRole,
      logRetention: 30,
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      reservedConcurrentExecutions: 10,
      environment: {
        VALIDAZS: vpc
          .selectSubnets({
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            onePerAz: true,
          })
          .availabilityZones.join(","),
        BUCKET: bucket.bucketName,
      },
    });

    const metadataTask = new tasks.LambdaInvoke(this, "MetadataTask", {
      lambdaFunction: metadataLambda,
      payloadResponseOnly: true,
    }).addRetry();

    let acbSuccessState: sfn.IChainable;
    const SuccessState = new sfn.Succeed(this, "Success");
    if (autoDeleteSnapshot) {
      const deleteSnapshotTask = new tasks.CallAwsService(
        this,
        "DeleteSnapshotTask",
        {
          service: "backup",
          action: "deleteRecoveryPoint",
          iamResources: ["arn:aws:dynamodb:*:*:table/*/backup/*"],
          inputPath: "$.Output",
          parameters: {
            "BackupVaultName.$": "$.BackupVaultName",
            "RecoveryPointArn.$": "$.SnapshotArn",
          },
        }
      );

      acbSuccessState = deleteSnapshotTask.next(SuccessState);
    } else {
      acbSuccessState = SuccessState;
    }

    const ebsmachineTask = new tasks.StepFunctionsStartExecution(
      this,
      "Run EBS Backup Machine",
      {
        stateMachine: ebsbackupmachine.ebsmachine,
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      }
    ).addRetry();

    const rdsmachineTask = new tasks.StepFunctionsStartExecution(
      this,
      "Run RDS Export Machine",
      {
        stateMachine: rdsexportmachine.rdsmachine,
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      }
    ).addRetry();

    const ddbmachineTask = new tasks.StepFunctionsStartExecution(
      this,
      "Run DDB Export Machine",
      {
        stateMachine: ddbexportmachine.ddbmachine,
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      }
    ).addRetry();

    const acbdefinition = metadataTask.next(
      new sfn.Choice(this, "Snapshot type")
        .when(
          sfn.Condition.stringEquals("$.ResourceType", "EBS"),
          ebsmachineTask.next(acbSuccessState)
        )
        .when(
          sfn.Condition.or(
            sfn.Condition.stringEquals("$.ResourceType", "RDS"),
            sfn.Condition.stringEquals("$.ResourceType", "Aurora")
          ),
          rdsmachineTask.next(acbSuccessState)
        )
        .when(
          sfn.Condition.stringEquals("$.ResourceType", "DynamoDB"),
          ddbmachineTask.next(acbSuccessState)
        )
    );

    const acbmachine = new BaseStateMachine(
      this,
      "AWS Backup Actions Machine",
      {
        definition: acbdefinition,
      }
    ).statemachine;

    if (autoDeleteSnapshot) {
      acbmachine.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          resources: [
            `arn:aws:rds:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:snapshot:*`,
          ],
          actions: [
            "backup:DeleteRecoveryPoint",
            "rds:DeleteDBClusterSnapshot",
            "rds:DeleteDBSnapshot",
          ],
          conditions: {
            StringEquals: { [`aws:ResourceTag/${backupTag}`]: "true" },
          },
        })
      );

      acbmachine.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          resources: [`arn:aws:ec2:${cdk.Aws.REGION}::snapshot/*`],
          actions: ["backup:DeleteRecoveryPoint", "ec2:DeleteSnapshot"],
          conditions: {
            StringEquals: { [`aws:ResourceTag/${backupTag}`]: "true" },
          },
        })
      );

      acbmachine.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          resources: [
            `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/*/backup/*`,
          ],
          actions: ["backup:DeleteRecoveryPoint", "dynamodb:DeleteBackup"],
        })
      );
    }

    NagSuppressions.addResourceSuppressions(
      acbmachine.role,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Actions to delete EBS and RDS snapshots are restricted with a tag condition. " +
            "Actions to delete DynamoDB backups are restricted with a prefixed Resource. " +
            "States Actions are restricted with a prefixed Resource. ",
        },
      ],
      true
    );

    const backuptrigger = new events.Rule(this, "AWS Backup Completed", {
      eventPattern: {
        source: ["aws.backup"],
        detail: {
          eventName: ["BackupJobCompleted"],
          serviceEventDetails: {
            backupVaultArn: [this.node.tryGetContext("backupVault")],
          },
        },
      },
      targets: [new targets.SfnStateMachine(acbmachine)],
    });

    if (notificationAlias) {
      const notifyKey = new kms.Key(this, "NotifyKey", {
        enableKeyRotation: true,
        admins: [new iam.AccountRootPrincipal()],
        policy: new iam.PolicyDocument(),
      });

      notifyKey.addToResourcePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          resources: ["*"],
          principals: [new iam.ServicePrincipal("events.amazonaws.com")],
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        })
      );

      const notifyTopic = new sns.Topic(this, "NotifyTopic", {
        displayName: "AWS Backup Actions",
        masterKey: notifyKey,
      });

      const notifySub = new sns.Subscription(this, "NotifySub", {
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: notificationAlias,
        topic: notifyTopic,
      });

      const errorTrigger = new events.Rule(this, "AWS Backup Actions Failure", {
        eventPattern: {
          source: ["aws.states"],
          detail: {
            stateMachineArn: [acbmachine.stateMachineArn],
            status: ["FAILED"],
          },
        },
      });

      errorTrigger.addTarget(
        new targets.SnsTopic(notifyTopic, {
          message: events.RuleTargetInput.fromMultilineText(
            "There was an error exporting a backup.\n\n" +
              `State Machine: ${events.EventField.fromPath(
                "$.detail.stateMachineArn"
              )}\n` +
              `Execution: ${events.EventField.fromPath("$.detail.name")}\n\n` +
              `Details: https://console.aws.amazon.com/states/home?region=${
                cdk.Aws.REGION
              }#/executions/details/${events.EventField.fromPath(
                "$.detail.executionArn"
              )}`
          ),
        })
      );
    }

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/AwsBackupActionsStack/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a",
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "The LogRetention Lambda is created and managed by CDK.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason: "The LogRetention Lambda is created and managed by CDK.",
        },
      ],
      true
    );
  }
}
