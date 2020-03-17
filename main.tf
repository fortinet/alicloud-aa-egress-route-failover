

data "alicloud_regions" "current_region_ds" {
  current = true
}

data "alicloud_zones" "default" {
}
//Create a Random String to be used for the PSK secret.
resource "random_string" "psk" {
  length           = 16
  special          = true
  override_special = ""
}

//Random 3 char string appended to the ened of each name to avoid conflicts
resource "random_string" "random_name_post" {
  length           = 3
  special          = true
  override_special = ""
  min_lower        = 3
}

data "template_file" "setupPrimary" {
  template = "${file("${path.module}/ConfigScripts/primaryfortigateconfigscript")}"
  vars = {
    region     = "${var.region}",
    account_id = "${data.alicloud_account.current.id}"
    // Using the function.name attribute will result in a circular dependency
    function_service = "${var.cluster_name}-${random_string.random_name_post.result}"
    function_id      = "Fortigate-AA-Failover-${random_string.random_name_post.result}"
  }
}
data "template_file" "setupSecondary" {
  template = "${file("${path.module}/ConfigScripts/secondaryfortigateconfigscript")}"
  vars = {
    region     = "${var.region}",
    account_id = "${data.alicloud_account.current.id}"
    // Using the function.name attribute will result in a circular dependency
    function_service = "${var.cluster_name}-${random_string.random_name_post.result}"
    function_id      = "Fortigate-AA-Failover-${random_string.random_name_post.result}"
  }
}

resource "alicloud_ram_role" "ram_role" {
  name     = "${var.cluster_name}-FunctionCompute-Role-${random_string.random_name_post.result}"
  document = <<EOF
{
"Statement": [
    {
    "Action": "sts:AssumeRole",
    "Effect": "Allow",
    "Principal": {
        "Service": [
            "fc.aliyuncs.com"
        ]
    }
    }
],
"Version": "1"
}
EOF
  description = "this is a role test."
  force = true
}

resource "alicloud_ram_policy" "policy" {
  name = "${var.cluster_name}-Logging-Policy-${random_string.random_name_post.result}"
  depends_on = [
    alicloud_log_project.aafailoverLogging,
    alicloud_log_store.aafailoverLogging-Store,
  ]
  document = <<EOF
{
"Statement": [
{
    "Action": "log:PostLogStoreLogs",
    "Effect": "Allow",
    "Resource" : "acs:log:*:*:project/${alicloud_log_project.aafailoverLogging.name}/logstore/${alicloud_log_store.aafailoverLogging-Store.name}"
}
],
"Version": "1"
}
EOF
  description = "FortiGate aafailover Logging Policy"
  force       = true
}

//The following Policy is required to allow the Function to join the VPC
resource "alicloud_ram_policy" "policy_vpc" {
  name     = "${var.cluster_name}-function-vpc-policy-${random_string.random_name_post.result}"
  document = <<EOF
{
    "Version": "1",
    "Statement": [
        {
            "Action": [
                "vpc:DescribeVSwitchAttributes"
            ],
            "Resource": "*",
            "Effect": "Allow"
        },
        {
            "Action": [
                "ecs:CreateNetworkInterface",
                "ecs:DeleteNetworkInterface",
                "ecs:DescribeNetworkInterfaces",
                "ecs:CreateNetworkInterfacePermission",
                "ecs:DescribeNetworkInterfacePermissions",
                "ecs:DeleteNetworkInterfacePermission"
            ],
            "Resource": "*",
            "Effect": "Allow"
        }
    ]
}
EOF

  description = "FortiGate aafailover VPC Policy - Used to bind vpc to function compute during automated deploy"
  force = true
}

resource "alicloud_ram_role_policy_attachment" "attach" {
  policy_name = alicloud_ram_policy.policy.name
  policy_type = alicloud_ram_policy.policy.type
  role_name = alicloud_ram_role.ram_role.name
}

resource "alicloud_ram_role_policy_attachment" "attach_vpc" {
  policy_name = alicloud_ram_policy.policy_vpc.name
  policy_type = alicloud_ram_policy.policy_vpc.type
  role_name = alicloud_ram_role.ram_role.name
}

resource "alicloud_vpc" "vpc" {
  cidr_block = var.vpc_cidr //default is 172.16.0.0/16
  name = "${var.cluster_name}-${random_string.random_name_post.result}"
}

resource "alicloud_vswitch" "vsw" {
  vpc_id = alicloud_vpc.vpc.id
  cidr_block = var.vswitch_cidr_1 //172.16.0.0/24 default
  availability_zone = data.alicloud_zones.default.zones[0].id
}

//zone B
resource "alicloud_vswitch" "vsw2" {
  vpc_id = alicloud_vpc.vpc.id
  cidr_block = var.vswitch_cidr_2 //172.16.8.0/24 default
  availability_zone = data.alicloud_zones.default.zones[1].id
}
resource "alicloud_vswitch" "vsw_internal_A" {
  vpc_id = alicloud_vpc.vpc.id
  cidr_block = var.vswitch_cidr_interal_ZoneA //172.16.0.0/24 default
  availability_zone = data.alicloud_zones.default.zones[0].id
}
resource "alicloud_vswitch" "vsw_internal_B" {
  vpc_id = alicloud_vpc.vpc.id
  cidr_block = var.vswitch_cidr_interal_ZoneB //172.16.0.0/24 default
  availability_zone = data.alicloud_zones.default.zones[1].id
}
// Egress Route to Primary Fortigate
resource "alicloud_route_entry" "egress" {
  // The Default Route
  route_table_id = "${alicloud_vpc.vpc.route_table_id}"
  destination_cidrblock = "${var.default_egress_route}" //Default is 0.0.0.0/0
  nexthop_type = "NetworkInterface"
  nexthop_id = "${alicloud_network_interface.PrimaryFortiGateInterface.id}"
}
variable "custom_route_table_count" {
  type = number
  default = 2

}
//"${aws_instance.fortigate[count.index].id}"
resource "alicloud_route_table" "custom_route_tables" {
  count = var.split_egress_traffic == true ? 2 : 0
  vpc_id = alicloud_vpc.vpc.id
  name = "${var.cluster_name}-FortiGateEgress-${random_string.random_name_post.result}-${count.index}"
  description = "FortiGate Egress route tables, created with terraform."
}

resource "alicloud_route_entry" "custom_route_table_egress" {
  count = var.split_egress_traffic == true ? 2 : 0
  route_table_id = "${alicloud_route_table.custom_route_tables[count.index].id}"
  destination_cidrblock = "${var.default_egress_route}" //Default is 0.0.0.0/0
  nexthop_type = "NetworkInterface"
  name = count.index == 0 ? "${alicloud_network_interface.PrimaryFortiGateInterface.id}" : "${alicloud_network_interface.SecondaryFortigateInterface.id}"
  nexthop_id = count.index == 0 ? "${alicloud_network_interface.PrimaryFortiGateInterface.id}" : "${alicloud_network_interface.SecondaryFortigateInterface.id}"
}

resource "alicloud_route_table_attachment" "custom_route_table_attachment_private" {
  count = var.split_egress_traffic == true ? 2 : 0
  vswitch_id     = count.index == 0 ? "${alicloud_vswitch.vsw_internal_A.id}" : "${alicloud_vswitch.vsw_internal_B.id}"
  route_table_id = "${alicloud_route_table.custom_route_tables[count.index].id}"
}

resource "alicloud_route_table_attachment" "custom_route_table_attachment_public" {
  count = var.split_egress_traffic == true ? 2 : 0
  vswitch_id     = count.index == 0 ? "${alicloud_vswitch.vsw.id}" : "${alicloud_vswitch.vsw2.id}"
  route_table_id = "${alicloud_route_table.custom_route_tables[count.index].id}"
}


//Security Group
resource "alicloud_security_group" "SecGroup" {
  name = "${var.cluster_name}-SecGroup-${random_string.random_name_post.result}"
  description = "New security group"
  vpc_id = alicloud_vpc.vpc.id
}

//Security Group Function Instances
resource "alicloud_security_group" "SecGroup_FC" {
  name = "${var.cluster_name}-SecGroup-FC-${random_string.random_name_post.result}"
  description = "New security group"
  vpc_id = alicloud_vpc.vpc.id
}

//Allow All Ingress for Firewall
resource "alicloud_security_group_rule" "allow_all_tcp_ingress" {
  type = "ingress"
  ip_protocol = "tcp"
  nic_type = "intranet"
  policy = "accept"
  port_range = "1/65535"
  priority = 1
  security_group_id = alicloud_security_group.SecGroup.id
  cidr_ip = "0.0.0.0/0"
}

//Allow All Egress Traffic - ESS
resource "alicloud_security_group_rule" "allow_all_tcp_egress" {
  type = "egress"
  ip_protocol = "tcp"
  nic_type = "intranet"
  policy = "accept"
  port_range = "1/65535"
  priority = 1
  security_group_id = alicloud_security_group.SecGroup.id
  cidr_ip = "0.0.0.0/0"
}

//Allow Private Subnets to access function compute
resource "alicloud_security_group_rule" "allow_a_class_ingress" {
  type = "ingress"
  ip_protocol = "tcp"
  nic_type = "intranet"
  policy = "accept"
  port_range = "1/65535"
  priority = 1
  security_group_id = alicloud_security_group.SecGroup_FC.id
  cidr_ip = "10.10.0.0/8"
}

resource "alicloud_security_group_rule" "allow_b_class_ingress" {
  type = "ingress"
  ip_protocol = "tcp"
  nic_type = "intranet"
  policy = "accept"
  port_range = "1/65535"
  priority = 1
  security_group_id = alicloud_security_group.SecGroup_FC.id
  cidr_ip = "172.16.0.0/12"
}

resource "alicloud_security_group_rule" "allow_c_class_ingress" {
  type = "ingress"
  ip_protocol = "tcp"
  nic_type = "intranet"
  policy = "accept"
  port_range = "1/65535"
  priority = 1
  security_group_id = alicloud_security_group.SecGroup_FC.id
  cidr_ip = "192.168.0.0/16"
}

//Allow All Egress Traffic - Function Compute
resource "alicloud_security_group_rule" "allow_all_tcp_egress_FC" {
  type = "egress"
  ip_protocol = "tcp"
  nic_type = "intranet"
  policy = "accept"
  port_range = "1/65535"
  priority = 1
  security_group_id = alicloud_security_group.SecGroup_FC.id
  cidr_ip = "0.0.0.0/0"
}


//Create the Function Service
resource "alicloud_fc_service" "fortigate-failover-service" {
  depends_on = [alicloud_ram_role.ram_role]
  name = "${var.cluster_name}-${random_string.random_name_post.result}" //Removed "service" from name to keep URL under 127 characters.
  description = "Created by terraform"
  internet_access = true
  role = alicloud_ram_role.ram_role.arn
  log_config {
    project = alicloud_log_project.aafailoverLogging.name
    logstore = alicloud_log_store.aafailoverLogging-Store.name
  }

  //ENI vswitch attachment:
  //Function Compute runs in the VPC.
  //The Indonesia Region requires this attachment in zone b whereas others require it in zone a
  vpc_config {
    vswitch_ids = [var.region == "ap-southeast-5" ? alicloud_vswitch.vsw2.id : alicloud_vswitch.vsw.id]
    security_group_id = alicloud_security_group.SecGroup_FC.id
  }
}

//Function
resource "alicloud_fc_function" "fortigate-AA-Failover" {
  service = alicloud_fc_service.fortigate-failover-service.name
  name = "Fortigate-AA-Failover-${random_string.random_name_post.result}"
  description = "FortiGate aafailover - AliCloud Created by Terraform"
  filename = "./dist/failoverAAindex.zip"
  memory_size = "512"
  runtime = "nodejs8"
  handler = "index.main"
  timeout = "500"
  environment_variables = {
    managedby = "Created with Terraform"
    REGION = var.region
    ENDPOINT_ESS = "https://vpc.aliyuncs.com"
    ENDPOINT_ECS = "https://ecs.aliyuncs.com"
    ACCESS_KEY_SECRET = var.secret_key
    ACCESS_KEY_ID = var.access_key
    PRIMARY_FORTIGATE_ID = "${alicloud_instance.PrimaryFortigate.id}"
    SECONDARY_FORTIGATE_ID = "${alicloud_instance.SecondaryFortigate.id}"
    ROUTE_TABLE_ID = var.split_egress_traffic == true ? "${alicloud_route_table.custom_route_tables[0].id},${alicloud_route_table.custom_route_tables[1].id},${alicloud_vpc.vpc.route_table_id}":"${alicloud_vpc.vpc.route_table_id}" //default vpc route. Can be multiple seperated by comma - no spaces allowed.
    PRIMARY_FORTIGATE_SEC_ENI = "${alicloud_network_interface.PrimaryFortiGateInterface.id}"
    SECONDARY_FORTIGATE_SEC_ENI = "${alicloud_network_interface.SecondaryFortigateInterface.id}"
    PIN_TO = var.split_egress_traffic == true ? "both" : "${alicloud_network_interface.PrimaryFortiGateInterface.id}" //Pin Healthy state to Primary Fortigate Secondary ENI
  }
}
//Function Compute Trigger
resource "alicloud_fc_trigger" "httptrigger" {
  service = alicloud_fc_service.fortigate-failover-service.name
  function = alicloud_fc_function.fortigate-AA-Failover.name
  name = "HTTPTrigger"
  type = "http"
  config = <<EOF
        {
            "methods": ["GET","POST"],
            "authType": "anonymous",
            "sourceConfig": {
                "project": "project-for-fc",
                "logstore": "project-for-fc"
            },
            "jobConfig": {
                "maxRetryTime": 3,
                "triggerInterval": 200
            },
            "functionParameter": {
                "a": "b",
                "c": "d"
            },
            "logConfig": {
                "project": "${alicloud_log_project.aafailoverLogging.name}",
                "logstore": "${alicloud_log_store.aafailoverLogging-Store.name}"
            },
            "enable": true
        }

EOF

}
resource "alicloud_fc_function" "fortigate-callHealthCheck" {
  service     = alicloud_fc_service.fortigate-failover-service.name
  name        = "Fortigate-callHealthCheck-${random_string.random_name_post.result}"
  description = "FortiGate AA-Failover - AliCloud Created by Terraform"
  filename    = "./dist/callHealthCheck.zip"
  memory_size = "512"
  runtime     = "nodejs8"
  handler     = "callHealthCheck.callHealthCheck"
  timeout     = "500"
  environment_variables = {
    managedby = "Created with Terraform"
    FULL_URL  = "https://${data.alicloud_account.current.id}.${var.region}-internal.fc.aliyuncs.com/2016-08-15/proxy/${alicloud_fc_service.fortigate-failover-service.name}/${alicloud_fc_function.fortigate-AA-Failover.name}/"
    API_KEY   = " "
  }
}

//Function Compute Trigger
resource "alicloud_fc_trigger" "timer" {
  //callHealthCheck.callHealthCheck
  service  = alicloud_fc_service.fortigate-failover-service.name
  function = alicloud_fc_function.fortigate-callHealthCheck.name
  name     = "CronTrigger"
  type     = "timer"
  config   = <<EOF
{
            "methods": ["GET","POST"],
            "authType": "anonymous",
            "sourceConfig": {
                "project": "project-for-fc",
                "logstore": "project-for-fc"
            },
            "jobConfig": {
                "maxRetryTime": 3,
                "triggerInterval": 60
            },
            "functionParameter": {
                "a": "b",
                "c": "d"
            },
            "logConfig": {
                "project": "${alicloud_log_project.aafailoverLogging.name}",
                "logstore": "${alicloud_log_store.aafailoverLogging-Store.name}"
            },
            "cronExpression": "@every 1m",
            "enable": true
        }

EOF

}



resource "alicloud_log_project" "aafailoverLogging" {
  name = "fortigate-aafailover-log-${random_string.random_name_post.result}" //Name must be lower case
  description = "created by terraform"
}

resource "alicloud_log_store" "aafailoverLogging-Store" {
  project = alicloud_log_project.aafailoverLogging.name
  name = "aa-failoverlog-store-${random_string.random_name_post.result}"
  shard_count = 3
  auto_split = true
  max_split_shard_count = 60
  append_meta = true
  retention_period = 15
}

resource "alicloud_log_store_index" "log_store_index" {
  project = alicloud_log_project.aafailoverLogging.name
  logstore = alicloud_log_store.aafailoverLogging-Store.name
  full_text {
    case_sensitive = true
    token = " #$%^*\r\n	"
  }
  field_search {
    name = "test"
    enable_analytics = true
  }
}
// ECS Instances
// Primary Fortigate

resource "alicloud_instance" "PrimaryFortigate" {
  depends_on =  [alicloud_network_interface.PrimaryFortiGateInterface]
  availability_zone = "${data.alicloud_zones.default.zones.0.id}"
  security_groups = "${alicloud_security_group.SecGroup.*.id}"
  image_id = "${length(var.instance_ami) > 1 ? var.instance_ami : data.alicloud_images.ecs_image.images.0.id}" //grab the first image that matches the regex
  instance_type = "${data.alicloud_instance_types.types_ds.instance_types.0.id}"
  system_disk_category = "cloud_efficiency"
  instance_name = "${var.cluster_name}-Primary-FortiGate-${random_string.random_name_post.result}"
  vswitch_id = "${alicloud_vswitch.vsw.id}"
  user_data = "${data.template_file.setupPrimary.rendered}"
  internet_max_bandwidth_in = 200
  internet_max_bandwidth_out = 100
  private_ip = "172.16.0.100"
  //Logging Disk
  data_disks {
    size = 30
    category = "cloud_ssd"
    delete_with_instance = true
  }
}
//Secondary ENI Primary FortiGate
resource "alicloud_network_interface" "PrimaryFortiGateInterface" {
  name = "${var.cluster_name}-PrimaryPrivateENI-${random_string.random_name_post.result}"
  vswitch_id = "${alicloud_vswitch.vsw_internal_A.id}"
  security_groups = ["${alicloud_security_group.SecGroup.id}"]
}

resource "alicloud_network_interface_attachment" "PrimaryFortigateattachment" {
  instance_id = "${alicloud_instance.PrimaryFortigate.id}"
  network_interface_id = "${alicloud_network_interface.PrimaryFortiGateInterface.id}"
}

// Secondary Fortigate
resource "alicloud_instance" "SecondaryFortigate" {
  depends_on =  [alicloud_network_interface.SecondaryFortigateInterface]
  availability_zone = "${data.alicloud_zones.default.zones.1.id}"
  security_groups = "${alicloud_security_group.SecGroup.*.id}"
  image_id = "${length(var.instance_ami) > 1 ? var.instance_ami : data.alicloud_images.ecs_image.images.0.id}" //grab the first image that matches the regex
  instance_type = "${data.alicloud_instance_types.types_ds.instance_types.0.id}"
  system_disk_category = "cloud_efficiency"
  instance_name = "${var.cluster_name}-Secondary-FortiGate-${random_string.random_name_post.result}"
  vswitch_id = "${alicloud_vswitch.vsw2.id}"
  user_data = "${data.template_file.setupSecondary.rendered}"
  internet_max_bandwidth_in = 200
  internet_max_bandwidth_out = 100
  private_ip = "172.16.8.100"

  //Logging Disk
  data_disks {
    size = 30
    category = "cloud_ssd"
    delete_with_instance = true
  }
}
//Secondary ENI Secondary FortiGate
resource "alicloud_network_interface" "SecondaryFortigateInterface" {
  name = "${var.cluster_name}-SecondaryPrivateENI${random_string.random_name_post.result}"
  vswitch_id = "${alicloud_vswitch.vsw_internal_B.id}"
  security_groups = ["${alicloud_security_group.SecGroup.id}"]
}

resource "alicloud_network_interface_attachment" "SecondaryFortigateAttachment" {
  instance_id = "${alicloud_instance.SecondaryFortigate.id}"
  network_interface_id = "${alicloud_network_interface.SecondaryFortigateInterface.id}"
}
output "PrimaryFortigateIP" {
  value = "${alicloud_instance.PrimaryFortigate.public_ip}"
}
output "PrimaryFortigateID" {
  value = "${alicloud_instance.PrimaryFortigate.id}"
}
output "PrimaryFortiGate_SecondaryENI" {
  value = "${alicloud_network_interface.PrimaryFortiGateInterface.id}"
}
output "SecondaryFortigateIP" {
  value = "${alicloud_instance.SecondaryFortigate.public_ip}"
}
output "SecondaryFortigateID" {
  value = "${alicloud_instance.SecondaryFortigate.id}"
}
output "SecondaryFortiGate_SecondaryENI" {
  value = "${alicloud_network_interface.SecondaryFortigateInterface.id}"
}