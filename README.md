# Introduction

FortiGate AA Failover is a Function Compute and terraform module that allows for failover of egress routes.
The template deploys two functions which check the health of two FortiGates at regular intervals, if one of FortiGates fails a TCP health check the egresss routes are checked and changed to the other FortiGate.

By default the FortiGates are deployed with static IPs and a link-monitor setup between them. If a change in the link status is detected an automation stich will call the healthCheck function and begin the process of changing the routes to the healthy FortiGate.

The script supports multiple route tables. They can be supplied as a comma seperated list without any spaces under the environment variable ROUTE_TABLE_ID.


# Requirements
- A RAM user with an AccessKey and Secret. For details on creating a RAM user, refer to the AliCloud article Create a RAM user.
- terraform

# Deployment Overview
The terraform script will create the following:
- A Function compute service and two functions:
    A timer function that runs once per minute
    An http function that will execute the healthchecks and route changes.
- A VPC
- Two vswitches
- A routetable with a default route to the Primary FortiGate
- Two FortiGates in seperate AZ
- A logging project and logstore
- Two Security Groups, one for internal and one for external.
- An AliCloud RAM policy.


# Deployment
> **Note:**  a RAM user with access to ECS/VPC/RAM/FC is required to deploy.

1. Unzip the release package
2. In the root directory run `terraform init`
3. Run `terraform apply -var access_key="<access_key>" -var secret_key="<secret_key>" ` or place the variables into the terraform file
4. To destroy run `terraform destroy -var access_key="<access_key>" -var secret_key="<secret_key>" `

    The Fortigate Configs deployed via cloud-init can be found under ConfigScripts/ and can be used to configure the deployment as needed.
    By default they are created with static IPs and a link-monitor between them.

# Support

Fortinet-provided scripts in this and other GitHub projects do not fall under the regular Fortinet technical support scope and are not supported by FortiCare Support Services.
For direct issues, please refer to the [Issues](https://github.com/fortinet/load-balancer-rule-sync/issues) tab of this GitHub project.
For other questions related to this project, contact [github@fortinet.com](mailto:github@fortinet.com).

## License

[License](./LICENSE) © Fortinet Technologies. All rights reserved.
