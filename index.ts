// Copyright 2016-2023, Pulumi Corporation.  All rights reserved.

import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";

// An ECS cluster to deploy into.
const cluster = new aws.ecs.Cluster("cluster", {});

// An ALB to serve the container endpoint to the internet.
const loadbalancer = new awsx.lb.ApplicationLoadBalancer("loadbalancer", {});

// An ECR repository to store our application's container image.
const repo = new awsx.ecr.Repository("repo", {
    forceDelete: true,
});

// Build and publish our application's container image from ./app to the ECR repository.
const image = new awsx.ecr.Image("image", {
    repositoryUrl: repo.url,
    context: "./app",
    platform: "linux/amd64",
});

// --- Shared task definition args for all services below ---
const taskDefArgs: awsx.ecs.FargateServiceArgs["taskDefinitionArgs"] = {
    container: {
        name: "service-container",
        image: image.imageUri,
        cpu: 128,
        memory: 512,
        essential: true,
        portMappings: [{
            containerPort: 80,
            targetGroup: loadbalancer.defaultTargetGroup,
        }],
    },
};

// =============================================================================
// BROKEN Approach 1: customTimeouts directly on the FargateService component.
//
// This does NOT work. customTimeouts here applies to the awsx:ecs:FargateService
// component resource itself, not to the underlying aws:ecs/service:Service child
// resource where the steady-state wait (and timeout) actually occurs.
// =============================================================================
const serviceBroken1 = new awsx.ecs.FargateService("service-broken-1", {
    cluster: cluster.arn,
    assignPublicIp: true,
    taskDefinitionArgs: taskDefArgs,
}, {
    customTimeouts: {   // <-- Has no effect on the child aws:ecs:Service timeout
        create: "30m",
        update: "30m",
        delete: "20m",
    },
});

// =============================================================================
// BROKEN Approach 2: "transformations" on the FargateService component.
//
// This does NOT work either. awsx:ecs:FargateService is a REMOTE component —
// its children are created server-side by the awsx provider process, not locally
// in the user's program. The older "transformations" API only intercepts children
// created locally, so the callback fires for the FargateService itself but never
// for the child aws:ecs/service:Service.
// =============================================================================
const serviceBroken2 = new awsx.ecs.FargateService("service-broken-2", {
    cluster: cluster.arn,
    assignPublicIp: true,
    taskDefinitionArgs: taskDefArgs,
}, {
    transformations: [(args) => {   // <-- Never fires for aws:ecs/service:Service
        if (args.type === "aws:ecs/service:Service") {
            args.opts.customTimeouts = {
                create: "30m",
                update: "30m",
                delete: "20m",
            };
        }
        return { props: args.props, opts: args.opts };
    }],
});

// =============================================================================
// WORKING Approach A: continueBeforeSteadyState
//
// Skips the steady-state wait entirely. Pulumi returns immediately after the ECS
// service API call succeeds, without waiting for tasks to stabilize. Use this
// when you don't need Pulumi to verify the deployment reached steady state.
// =============================================================================
const serviceWorkingA = new awsx.ecs.FargateService("service-working-a", {
    cluster: cluster.arn,
    assignPublicIp: true,
    continueBeforeSteadyState: true,
    taskDefinitionArgs: taskDefArgs,
});

// =============================================================================
// WORKING Approach B: "transforms" (not "transformations")
//
// The newer "transforms" API propagates into remote component children, so it
// DOES reach the aws:ecs/service:Service resource. This lets you keep the
// steady-state wait but extend the timeout beyond the default 20 minutes.
// =============================================================================
const serviceWorkingB = new awsx.ecs.FargateService("service-working-b", {
    cluster: cluster.arn,
    assignPublicIp: true,
    taskDefinitionArgs: taskDefArgs,
}, {
    transforms: [(args) => {
        if (args.type === "aws:ecs/service:Service") {
            return {
                props: args.props,
                opts: pulumi.mergeOptions(args.opts, {
                    customTimeouts: {
                        create: "30m",
                        update: "30m",
                        delete: "20m",
                    },
                }),
            };
        }
        return undefined;
    }],
});

// The URL at which the container's HTTP endpoint will be available.
export const frontendURL = pulumi.interpolate`http://${loadbalancer.loadBalancer.dnsName}`;
