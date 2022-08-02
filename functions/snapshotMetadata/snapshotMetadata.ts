// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as EC2 from "aws-sdk/clients/ec2";
import * as RDS from "aws-sdk/clients/rds";
import * as DDB from "aws-sdk/clients/dynamodb";
import * as S3 from "aws-sdk/clients/s3";
import * as ARN from "@aws-sdk/util-arn-parser";
import assert = require("assert");

let ec2 = new EC2();
let rds = new RDS();
let ddb = new DDB();
let s3 = new S3();

type resourceTypes = "EBS" | "Aurora" | "RDS" | "DynamoDB";

interface BackupEvent {
  detail: {
    serviceEventDetails: {
      backupJobId: string;
      backupVaultName: string;
      resourceType: resourceTypes;
      resourceArn: string;
      recoveryPointArn: string;
      state: string;
      creationDate: {
        seconds: number;
        nanos: number;
      };
    };
  };
}

interface SnapshotMetadata {
  AvailabilityZone: string;
  SnapshotArn: string;
  SnapshotId: string;
  ResourceType: resourceTypes;
  BackupVaultName: string;
  ResourceArn: string;
  S3BucketName: string;
  S3Prefix: string;
  CreationDate: string;
  Tags: Array<Object>;
  Engine: string;
}

// anti bucket sniping control
const checkBucketOwner = async function (bucket: string): Promise<Boolean> {
  const data = await s3.listBuckets().promise();
  return data.Buckets!.some((b) => b.Name === bucket);
};

exports.metadataHandler = async function (
  event: BackupEvent
): Promise<SnapshotMetadata> {
  if (event.detail.serviceEventDetails.state === "COMPLETED") {
    let azlist: string[] = (process.env.VALIDAZS as string).split(",");

    let tags: Array<Object> = [];
    let engine: string = "";

    assert(typeof event.detail.serviceEventDetails.backupJobId === "string");
    assert(
      typeof event.detail.serviceEventDetails.backupVaultName === "string" &&
        /^[a-zA-Z0-9\-\_]{2,50}$/.test(
          event.detail.serviceEventDetails.backupVaultName
        )
    );
    assert(
      typeof event.detail.serviceEventDetails.resourceArn === "string" &&
        ARN.validate(event.detail.serviceEventDetails.resourceArn)
    );
    assert(
      typeof event.detail.serviceEventDetails.recoveryPointArn === "string" &&
        ARN.validate(event.detail.serviceEventDetails.recoveryPointArn)
    );
    assert(
      typeof event.detail.serviceEventDetails.creationDate.seconds === "number"
    );
    assert(
      typeof event.detail.serviceEventDetails.creationDate.nanos === "number"
    );

    if (!(await checkBucketOwner(process.env.BUCKET!))) {
      throw new Error(
        `Backup bucket ${process.env.BUCKET!} is not owned by this account.`
      );
    }

    const creationDate = new Date(
      event.detail.serviceEventDetails.creationDate.seconds * 1000 +
        event.detail.serviceEventDetails.creationDate.nanos / 1000000
    );

    switch (event.detail.serviceEventDetails.resourceType) {
      case "EBS": {
        const data = await ec2
          .describeTags({
            Filters: [
              {
                Name: "resource-id",
                Values: [
                  event.detail.serviceEventDetails.resourceArn.split("/")[1],
                ],
              },
            ],
          })
          .promise();
        tags = data.Tags!;
        break;
      }
      case "Aurora": {
        const metadataPromise = rds
          .describeDBClusterSnapshots({
            DBClusterSnapshotIdentifier:
              event.detail.serviceEventDetails.resourceArn,
          })
          .promise();
        const tagdataPromise = rds
          .listTagsForResource({
            ResourceName: event.detail.serviceEventDetails.resourceArn,
          })
          .promise();
        Promise.all([metadataPromise, tagdataPromise]).then(
          ([metadata, tagdata]) => {
            engine = metadata.DBClusterSnapshots![0].Engine as string;
            tags = tagdata.TagList!;
          }
        );
        break;
      }
      case "RDS": {
        const metadataPromise = rds
          .describeDBSnapshots({
            DBSnapshotIdentifier: event.detail.serviceEventDetails.resourceArn,
          })
          .promise();
        const tagdataPromise = rds
          .listTagsForResource({
            ResourceName: event.detail.serviceEventDetails.resourceArn,
          })
          .promise();
        Promise.all([metadataPromise, tagdataPromise]).then(
          ([metadata, tagdata]) => {
            engine = metadata.DBSnapshots![0].Engine as string;
            tags = tagdata.TagList!;
          }
        );
        break;
      }
      case "DynamoDB": {
        const data = await ddb
          .listTagsOfResource({
            ResourceArn: event.detail.serviceEventDetails.resourceArn,
          })
          .promise();
        tags = data.Tags!;
        break;
      }
      default: {
        throw new Error(
          `Invalid resourceType: ${event.detail.serviceEventDetails.resourceType}`
        );
      }
    }

    return {
      AvailabilityZone: azlist[Math.floor(Math.random() * azlist.length)],
      SnapshotArn: event.detail.serviceEventDetails.recoveryPointArn,
      SnapshotId: event.detail.serviceEventDetails.recoveryPointArn
        .split("/")
        .slice(-1)[0],
      BackupVaultName: event.detail.serviceEventDetails.backupVaultName,
      ResourceArn: event.detail.serviceEventDetails.resourceArn,
      ResourceType: event.detail.serviceEventDetails.resourceType,
      S3BucketName: process.env.BUCKET!,
      S3Prefix: [
        ...event.detail.serviceEventDetails.resourceArn.split(":"),
        "Y=" + creationDate.getUTCFullYear().toString().padStart(4, "0"),
        "M=" + (creationDate.getUTCMonth() + 1).toString().padStart(2, "0"),
        "D=" + creationDate.getUTCDate().toString().padStart(2, "0"),
        event.detail.serviceEventDetails.backupJobId,
      ].join("/"),
      CreationDate: creationDate.toISOString(),
      Tags: tags,
      Engine: engine,
    };
  } else
    throw new Error(
      `Backup job ${event.detail.serviceEventDetails.backupJobId} terminated in state ${event.detail.serviceEventDetails.state}`
    );
};
