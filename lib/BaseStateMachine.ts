// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  aws_kms as kms,
  aws_logs as logs,
  aws_iam as iam,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import { NagSuppressions } from "cdk-nag";

export interface BaseStateMachineProps {
  definition: sfn.Chain;
}

export class BaseStateMachine extends Construct {
  public readonly statemachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: BaseStateMachineProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "State Machine LogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    this.statemachine = new sfn.StateMachine(this, "State Machine", {
      definition: props.definition,
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
      },
      tracingEnabled: true,
    });
  }
}
