// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  aws_ec2 as ec2,
  aws_batch as cfnbatch,
  aws_iam as iam,
} from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as batch from "@aws-cdk/aws-batch-alpha";
import { NagSuppressions } from "cdk-nag";

import { ManagedPrefixLists } from "./PrefixLists";

export interface BatchCEProps {
  vpc: ec2.Vpc;
  tags: Record<string, string>;
}

export class BatchCE extends Construct {
  public readonly ces: Record<string, batch.ComputeEnvironment>;
  public readonly jqs: Record<string, batch.JobQueue>;
  public readonly cesg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: BatchCEProps) {
    super(scope, id);

    const vpcendpointsg = new ec2.SecurityGroup(
      this,
      "VPCEndpointSecurityGroup",
      {
        vpc: props.vpc,
        allowAllOutbound: false,
        description:
          "Allow inbound traffic to Interface endpoints from Batch jobs",
      }
    );

    props.vpc.addInterfaceEndpoint("EcrDockerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      securityGroups: [vpcendpointsg],
      open: false,
    });

    props.vpc.addInterfaceEndpoint("EcrEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      securityGroups: [vpcendpointsg],
      open: false,
    });

    props.vpc.addInterfaceEndpoint("EcsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECS,
      securityGroups: [vpcendpointsg],
      open: false,
    });

    props.vpc.addInterfaceEndpoint("EcsAgentEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECS_AGENT,
      securityGroups: [vpcendpointsg],
      open: false,
    });

    props.vpc.addInterfaceEndpoint("EcsTelemetryEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
      securityGroups: [vpcendpointsg],
      open: false,
    });

    props.vpc.addInterfaceEndpoint("CloudwatchLogsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      securityGroups: [vpcendpointsg],
      open: false,
    });

    // Create an AWS Batch Compute Environment(CE) per AZ, a Job Queue(JQ) per CE.
    this.cesg = new ec2.SecurityGroup(this, "BatchCESecurityGroup", {
      vpc: props.vpc,
      allowAllOutbound: false,
      description:
        "Isolated security group for batch jobs with no ingress and only allows egress within the VPC.",
    });

    const gatewayPrefixes = new ManagedPrefixLists(
      this,
      "Managed Prefix Lists"
    );
    this.cesg.connections.allowTo(vpcendpointsg, ec2.Port.tcp(443));
    this.cesg.addEgressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(53),
      "Enable DNS lookups"
    );
    this.cesg.addEgressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.udp(53),
      "Enable DNS lookups"
    );
    this.cesg.connections.allowTo(
      ec2.Peer.prefixList(
        gatewayPrefixes.ManagedPrefixLists.getResponseField(
          "PrefixLists.0.PrefixListId"
        )
      ),
      ec2.Port.tcp(443),
      "Allow S3/DynamoDB via gateway endpoints"
    );
    this.cesg.connections.allowTo(
      ec2.Peer.prefixList(
        gatewayPrefixes.ManagedPrefixLists.getResponseField(
          "PrefixLists.1.PrefixListId"
        )
      ),
      ec2.Port.tcp(443),
      "Allow S3/DynamoDB via gateway endpoints"
    );

    const batchServiceRole = new iam.Role(this, "Batch Service Role", {
      assumedBy: new iam.ServicePrincipal("batch.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSBatchServiceRole"
        ),
      ],
    });

    const batchInstanceRole = new iam.Role(this, "Batch Instance Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      inlinePolicies: {
        ECSInstancePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "ec2:DescribeTags",
                "ecs:CreateCluster",
                "ecs:DiscoverPollEndpoint",
                "ecr:GetAuthorizationToken",
              ],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ecs:Poll", "ecs:UpdateContainerInstancesState"],
              resources: [
                cdk.Stack.of(this).formatArn({
                  service: "ecs",
                  resource: "container-instance",
                  resourceName: "*",
                  arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
                }),
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "ecs:RegisterContainerInstance",
                "ecs:StartTelemetrySession",
                "ecs:SubmitAttachmentStateChange",
                "ecs:SubmitContainerStateChange",
                "ecs:SubmitTaskStateChange",
              ],
              resources: [
                cdk.Stack.of(this).formatArn({
                  service: "ecs",
                  resource: "cluster",
                  resourceName: "BatchComputeEnvironments-*",
                  arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
                }),
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
              ],
              resources: [
                cdk.Stack.of(this).formatArn({
                  service: "ecr",
                  resource: "repository",
                  resourceName: "*",
                  arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
                }),
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [
                cdk.Stack.of(this).formatArn({
                  service: "logs",
                  resource: "log-group",
                  resourceName: "/aws/batch/job:*",
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                }),
              ],
            }),
          ],
        }),
      },
    });

    const batchInstanceProfile = new iam.CfnInstanceProfile(
      this,
      "Batch Instance Profile",
      {
        roles: [batchInstanceRole.roleName],
      }
    );

    this.ces = {};
    this.jqs = {};
    props.vpc
      .selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      })
      .subnets.forEach((subnet: ec2.ISubnet) => {
        const ce = new batch.ComputeEnvironment(
          this,
          `ComputeEnv${subnet.availabilityZone.slice(-1).toUpperCase()}`,
          {
            computeResources: {
              vpc: props.vpc,
              securityGroups: [this.cesg],
              allocationStrategy:
                batch.AllocationStrategy.SPOT_CAPACITY_OPTIMIZED,
              type: batch.ComputeResourceType.SPOT,
              instanceTypes: [
                new ec2.InstanceType("c5.large"),
                new ec2.InstanceType("c5n.large"),
                new ec2.InstanceType("m5.large"),
                new ec2.InstanceType("m5n.large"),
                new ec2.InstanceType("r5.large"),
                new ec2.InstanceType("r5n.large"),
                new ec2.InstanceType("c5.xlarge"),
                new ec2.InstanceType("c5n.xlarge"),
                new ec2.InstanceType("m5.xlarge"),
                new ec2.InstanceType("m5n.xlarge"),
                new ec2.InstanceType("r5.xlarge"),
                new ec2.InstanceType("r5n.xlarge"),
              ],
              instanceRole: batchInstanceProfile.attrArn,
              // computeResourcesTags: Object.entries(tags).map(([key, value]) => { return new cdk.Tag(key, value) }), // bug https://github.com/aws/aws-cdk/issues/8416
              vpcSubnets: props.vpc.selectSubnets({
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                availabilityZones: [subnet.availabilityZone],
              }),
            },
            serviceRole: batchServiceRole,
          }
        );

        // Tag Compute Environment Instances. workaround https://github.com/aws/aws-cdk/issues/8416
        const child = ce.node.defaultChild as cfnbatch.CfnComputeEnvironment;
        (child.computeResources as any).tags = props.tags;

        this.ces[subnet.availabilityZone] = ce;

        const jq = new batch.JobQueue(
          this,
          `JobQueue${subnet.availabilityZone.slice(-1).toUpperCase()}`,
          {
            computeEnvironments: [{ computeEnvironment: ce, order: 10 }],
          }
        );
        this.jqs[subnet.availabilityZone] = jq;
      });

    NagSuppressions.addResourceSuppressions(batchInstanceRole, [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "Batch Instance Service Role uses actions that can't be restricted by resources.",
      },
    ]);

    NagSuppressions.addResourceSuppressions(batchServiceRole, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "Batch Service Linked Role uses the recommended AWS managed policy.",
        appliesTo: [
          "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSBatchServiceRole",
        ],
      },
    ]);
  }
}
