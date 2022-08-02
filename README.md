# AWS Backup Actions Framework

AWS Backup Actions is a framework for automating actions triggered by AWS Backup events. 

This solution includes example implementations to export AWS EBS snapshots to compressed archives for long term archiving in Amazon S3 and exporting Amazon DynamoDB backups and Amazon RDS snapshots for supported [engines and versions][1] and [Aurora versions][2] to S3 in the Parquet format for queryable long term archiving. You can implement other use cases such as exporting engine native dumps from RDS snapshots by following the EBS example.

NOTE: This application will create IAM roles and policies.

## How does it work?
Any snapshot created in the designated AWS Backup Vault will trigger a process to restore the backup, copy the data to
S3, and delete the restored resource. The solution deletes the snapshot only on success so the AWS Backup retention can be used as a failsafe.

The solution uses AWS Step Functions to orchestrate the processes. AWS Lambda and AWS Batch with EC2 Spot Instances perform the
restore and backup processes.

### EBS
1. Restore the snapshot to a GP3 volume in a given AZ. Wait for it to become available.
2. Start a Batch job in the same AZ.
3. The Batch job attaches the EBS volume to the container instance in a way that allows the container running as root to access and mount the block device.
4. The files are archived and compressed using tar and streamed to S3.
5. If for any reason the filesystem on the EBS volume can't be mounted, the block device is copied with dd, compressed with gzip, and streamed to S3.
6. The restored volume is deleted after success or any failure.

### DynamoDB and supported RDS engines and versions
1. Call the API to export the snapshot in S3 in compressed Parquet format.
2. Monitor for success.

### How to implement support for other RDS engines
1. Restore the snapshot to a given AZ on a low cost instance type with GP2 volumes or Aurora with a random root password.
2. Store the password encrypted in SSM Parameter Store.
3. Start a Batch job in the same AZ.
4. The Batch job connects to the DB and runs the engine's dump command, compresses with gzip, and stream to S3.
5. The restored instance is terminated after success or any failure.

## Costs
Apart from the storage in S3 and the VPC Interface Endpoints, this solution only costs money while it is processing a snapshot.

Assuming the original data source was 100GB, the cost per export excluding storage and VPC Interface Endpoints follows:
EBS: ~$0.65
RDS: ~$1.05
DynamoDB: ~$10.05

The seven VPC Interface Endpoints are the highest cost of this solution at about $151 per month. The traffic outside the VPC is only for API calls to EC2, ECR, and Batch. S3 and DynamoDB traffic use VPC Gateway endpoints. Nothing in the solution listens for inbound traffic. A VPC NAT Gateway could be used for about $33 per month, but egress is not controlled. At your own risk, this solution can work without a NAT Gateway or VPC Interface Endpoints, but the EC2 instances managed by AWS Batch will require direct access to the Internet and public IP addresses. The Security Group can prevent inbound access from the Internet, and no ports get opened for inbound traffic.

## Deployment instructions
```
cp cdk.json.template cdk.json
```

Edit cdk.json to specify your account, region, backupVault, and tags. The Security Tag is optional to restrict the created IAM Roles
from deleting resources that weren't created by this application.

```
npm install
cd functions/sanpshotMetadata
npm install
cd ../..
npm run build
```

Set up your environment with AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and possibly AWS_SESSION_TOKEN to be able to
deploy in your account.

```
cdk synth
cdk deploy
```

### S3 Server Access Logs (Optional)
You can enable S3 Server Access Logs by specifying a bucket and prefix in `cdk.json`. The access logs bucket must be configured to [allow access from the Amazon S3 Log Delivery Group][3].

### S3 Lifecycle Rules (Optional)
For some use cases such as long term archiving, objects should only be deleted using Lifecycle Rules. Consider restricting deletes with MFA delete in the bucket policy.

You can configure the Lifecycle Rules in the `cdk.json` under the `lifecycleRules` key. For example:

```
"lifecycleRules: {
    "glacier": 10,
    "deepArchive": 101,
    "expiration": 2190
}
```

[1]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ExportSnapshot.html
[2]: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_ExportSnapshot.html
[3]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/enable-server-access-logging.html#grant-log-delivery-permissions-general
