import RPCClient from '@alicloud/pop-core';
import * as net from 'net'; // TCP health check.
// AliCloudModels is used throughout the doc, this is a linting error.
// eslint-disable-next-line no-unused-vars
import * as AliCloudModels from './AliCloudModels';

const {
        ACCESS_KEY_ID,
        ACCESS_KEY_SECRET,
        ENDPOINT_ESS,
        ENDPOINT_ECS,
        REGION,
        PRIMARY_FORTIGATE_ID,
        SECONDARY_FORTIGATE_ID,
        PRIMARY_FORTIGATE_SEC_ENI,
        SECONDARY_FORTIGATE_SEC_ENI,
        PIN_TO // takes  instanceId or 'both'
    } = process.env,
    CLIENT_TIMEOUT = Number(process.env.CLIENT_TIMEOUT) || 5000,
    TCP_HEALTH_CHECK_TIMEOUT = Number(process.env.TCP_HEALTH_CHECK_TIMEOUT) || 3000,
    TCP_PROBE_PORT = Number(process.env.TCP_PROBE_PORT) || 22,
    ROUTE_TABLE_ID: string[] =
        (process.env.ROUTE_TABLE_ID && process.env.ROUTE_TABLE_ID.split(',')) || [],
    TIME_BETWEEN_ROUTE_TABLE_CALLS = Number(process.env.TIME_BETWEEN_ROUTE_TABLE_CALLS) || 1500;

const client = new RPCClient({
    accessKeyId: ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SECRET,
    endpoint: ENDPOINT_ESS,
    apiVersion: '2016-04-28', // https://github.com/aliyun/openapi-core-nodejs-sdk,
    opts: {
        timeout: CLIENT_TIMEOUT
    }
});
const ecsClient = new RPCClient({
    accessKeyId: ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SECRET,
    endpoint: ENDPOINT_ECS,
    apiVersion: '2014-05-26', // https://github.com/aliyun/openapi-core-nodejs-sdk,
    opts: {
        timeout: CLIENT_TIMEOUT
    }
});
export class RouteFailover {
    public async getFortigateHealth(instanceId): Promise<boolean> {
        const getFortigateIp = await this.getInstanceIp(instanceId);

        try {
            await this.tcpCheck(getFortigateIp, TCP_PROBE_PORT, TCP_HEALTH_CHECK_TIMEOUT);
        } catch (err) {
            console.log(`${instanceId}  did not respond to health check
                TCPHealthCheck error: ${err}`);
            return false;
        }
        return true;
    }
    public async getSecondaryEniHealth(instanceId): Promise<boolean> {
        let getSecondaryEniIp;
        try {
            getSecondaryEniIp = await this.getSecondaryEniIp(instanceId);
        } catch (err) {
            console.log(`Error in getSecondaryENIHhealth with instanceid ${instanceId} `, err);
        }
        if (!getSecondaryEniIp) {
            console.error(
                `getSecondaryEniIp returned falsy value. Returning false. For instanceId ${instanceId}.`
            );
            return false;
        }
        try {
            await this.tcpCheck(getSecondaryEniIp, TCP_PROBE_PORT, TCP_HEALTH_CHECK_TIMEOUT);
        } catch (err) {
            console.log(`${instanceId}  did not respond to health check
                TCPHealthCheck error: ${err}`);
            return false;
        }
        return true;
    }

    public async updateRoute(
        route: AliCloudModels.RouteEntry,
        newInstance: string,
        routeTableId: string
    ): Promise<void> {
        // Delete the route
        await this.removeRoute(route.InstanceId, routeTableId, route.DestinationCidrBlock);

        let tempTime = Date.now();
        let currentTime;
        // Check to see if the route table is available to be updated.
        // Requests can not be done in parallel, or all at once.
        let isRouteTableAvailable = await this.getRouteTableStatus(routeTableId);
        while (!isRouteTableAvailable) {
            currentTime = Date.now();
            // Wait 1.5 seconds between calls
            if (currentTime > tempTime + TIME_BETWEEN_ROUTE_TABLE_CALLS) {
                tempTime = Date.now();
                isRouteTableAvailable = await this.getRouteTableStatus(routeTableId);
            }
        }
        isRouteTableAvailable = await this.getRouteTableStatus(routeTableId);
        tempTime = Date.now();
        // Wait for the route to become available. Updates can only happen in serial.
        while (!isRouteTableAvailable) {
            currentTime = Date.now();
            // Wait 1.5 seconds between calls
            if (currentTime > tempTime + TIME_BETWEEN_ROUTE_TABLE_CALLS) {
                tempTime = Date.now();

                isRouteTableAvailable = await this.getRouteTableStatus(routeTableId);
            }
        }

        if (isRouteTableAvailable) {
            try {
                await this.createRoute(
                    routeTableId,
                    newInstance,
                    route.DestinationCidrBlock,
                    route.RouteEntryName
                );
            } catch (err) {
                throw console.error(
                    `Failed to add route ${route.DestinationCidrBlock} with instanceId ${newInstance} to ${ROUTE_TABLE_ID}`
                );
            }
        }
    }
    // Return true/false if route table is busy or free
    public async getRouteTableStatus(routeId): Promise<boolean> {
        let getUpdatedRouteTable: AliCloudModels.AliCloudRoutesList;
        try {
            getUpdatedRouteTable = await this.describeRouteTableList(routeId);
        } catch (err) {
            throw console.error('Error in checkState, failed to describe route table');
        }
        for (const item of getUpdatedRouteTable.RouteTables.RouteTable[0].RouteEntrys.RouteEntry) {
            if (item.Status !== 'Available') {
                return false;
            }
        }
        // Return true if no Status other than Available is found
        return true;
    }
    public tcpCheck(fortigateIp, tcpProbePort, tcpHealthCheckTimeout): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(tcpProbePort, fortigateIp, connected);
            const timeout = setTimeout(() => {
                socket.end();
                reject('timeout');
            }, tcpHealthCheckTimeout);
            socket.on('error', reject);
            function connected() {
                socket.end();
                clearTimeout(timeout);
                resolve();
            }
        });
    }

    public async describeECSInstance(region): Promise<AliCloudModels.AliCloudInstance> {
        const parameters = {
            RegionId: region
        };
        const options = {
            method: 'POST'
        };
        try {
            const clientData: AliCloudModels.AliCloudInstance = await ecsClient.request(
                'DescribeInstances',
                parameters,
                options
            );
            return clientData;
        } catch (err) {
            console.error(`Unable to fetch instances list from region: ${region}. Error: ${err}`);
            throw err;
        }
    }
    public async getSecondaryEniIp(instanceId: string): Promise<string> {
        console.log(`Getting Ip for Secondary ENI of ${instanceId}`);
        let getClientList;
        try {
            getClientList = await this.describeECSInstance(REGION);
        } catch (err) {
            console.error(`Unable to retrieve IP for secondary ENI of ${instanceId}`);
            throw err;
        }
        if (getClientList.Instances?.Instance) {
            for (const item of getClientList.Instances.Instance) {
                if (item.InstanceId === instanceId) {
                    // Ensure we have a secondary nic or else raise an error.
                    if (item.NetworkInterfaces?.NetworkInterface[1]) {
                        return item.NetworkInterfaces.NetworkInterface[1].PrimaryIpAddress;
                    } else {
                        console.error(`Did not find second nic for ${instanceId} in ${REGION}.`);
                        return null;
                    }
                }
            }
            console.log(`Did not find instance ${instanceId} in ${REGION}. `);
            return '';
        } else {
            const err = new Error(
                `Error parsing Instance JSON in getSecondaryEniIp. instanceId: ${instanceId}.`
            );
            console.error(err.message);
            throw err;
        }
    }
    public async getInstanceIp(instanceId: string): Promise<string> {
        console.log(`Getting Ip for instance ${instanceId}`);
        const getClientList: AliCloudModels.AliCloudInstance = await this.describeECSInstance(
            REGION
        );
        if (getClientList.Instances?.Instance) {
            for (const item of getClientList.Instances.Instance) {
                if (item.InstanceId === instanceId) {
                    console.log(item.NetworkInterfaces.NetworkInterface[0].PrimaryIpAddress);
                    return item.NetworkInterfaces.NetworkInterface[0].PrimaryIpAddress;
                }
            }
            throw console.error('error in getInstanceIp');
        } else {
            const err = new Error(`Error in GetInstanceIp, Could not parse data for ${instanceId}`);
            console.error(err);
            throw err;
        }
    }
    public async removeAllTaggedRoutes(tag, routeId): Promise<void> {
        console.log(`Removing All routes with Tag ${tag}`);
        const getRoutesList: AliCloudModels.AliCloudRoutesList = await this.describeRouteTableList(
            routeId
        );
        if (getRoutesList?.RouteTables?.RouteTable[0]?.RouteEntrys?.RouteEntry) {
            for (const item of getRoutesList.RouteTables.RouteTable[0].RouteEntrys.RouteEntry) {
                if (item.RouteEntryName === tag) {
                    console.log(item.NextHopId, item.RouteTableId, item.DestinationCidrBlock);
                    // NextHopId in deleting is the InstanceId when fetching the list.
                    await this.removeRoute(
                        item.InstanceId,
                        item.RouteTableId,
                        item.DestinationCidrBlock
                    );
                }
            }
        }
    }
    public async removeRoute(nextHopID, routeTableId, destinationCidrBlock): Promise<void> {
        let isRouteTableAvailable: boolean = await this.getRouteTableStatus(routeTableId);

        while (!isRouteTableAvailable) {
            await new Promise(resolve => setTimeout(resolve, TIME_BETWEEN_ROUTE_TABLE_CALLS));
            isRouteTableAvailable = await this.getRouteTableStatus(routeTableId);
        }
        const parameters = {
            RegionId: REGION,
            RouteTableId: routeTableId,
            DestinationCidrBlock: destinationCidrBlock,
            NextHopId: nextHopID
        };
        const options = {
            method: 'POST'
        };
        try {
            console.log(`Removing Route ${destinationCidrBlock}/${nextHopID} from ${routeTableId}`);
            await client.request('DeleteRouteEntry', parameters, options);
        } catch (err) {
            console.error(`Error in removeRoute. Error deleting route ${err.message || err}`);
        }
    }

    public async describeRouteTableList(routeId): Promise<AliCloudModels.AliCloudRoutesList> {
        console.log(`describing route table ${routeId}`);
        const parameters = {
            RegionId: REGION,
            RouteTableId: routeId
        };
        const options = {
            method: 'POST'
        };
        try {
            return await client.request('DescribeRouteTables', parameters, options);
        } catch (err) {
            console.error('Error in describeRouteTableList. Error deleting route ', err);
            throw err;
        }
    }
    public async createRoute(
        routeTableId,
        nextHopID,
        destinationCidrBlock,
        tagName
    ): Promise<void> {
        console.log(`Creating Route ${destinationCidrBlock} to ${nextHopID}`);
        const parameters = {
            RegionId: REGION,
            RouteTableId: routeTableId,
            NextHopId: nextHopID,
            NextHopType: 'NetworkInterface',
            DestinationCidrBlock: destinationCidrBlock,
            RouteEntryName: tagName // set the tag
        };
        const options = {
            method: 'POST'
        };
        try {
            await client.request('CreateRouteEntry', parameters, options);
        } catch (err) {
            console.error('Error in createRoute. ', err);
        }
    }
    // Called ModifyRouteEntry in AliCloud, this will change the Label/name given to a route
    public async changeRouteEntryTitle(): Promise<void> {
        const parameters = {
            RegionId: REGION
        };
        const options = {
            method: 'POST'
        };
        try {
            console.log('Modifing route');
            await client.request('ModifyRouteEntry', parameters, options);
        } catch (err) {
            console.error('Error in modifyRoute. ', err);
        }
    }
}
exports.main = async (request, response): Promise<void> => {
    console.log('Function Started');
    let getRoutesList: AliCloudModels.AliCloudRoutesList;

    const handleFailOver = new RouteFailover();

    // Check both instances to see if they are healthy since the Link status monitor does not
    // Show the calling instance ID or IP
    const [primaryHealthOK, secondaryHealthOK] = await Promise.all([
        handleFailOver.getSecondaryEniHealth(PRIMARY_FORTIGATE_ID),

        handleFailOver.getSecondaryEniHealth(SECONDARY_FORTIGATE_ID)
    ]);
    if (!primaryHealthOK && !secondaryHealthOK) {
        console.error('Neither Instance reported healthy.');
        // TODO: add probe until back up?
        console.error('Stopping check');
    } else if (primaryHealthOK && secondaryHealthOK) {
        console.log('Both Instances reported healthy');
        // If PIN_TO_INSTANCE enabled and both instances are healthy switch any routes to that instance.
        if (PIN_TO) {
            // If healthy and PIN_TO_INSTANCE is set to 'both'
            if (PIN_TO.toLowerCase() === 'both') {
                console.log('PIN_TO is set to both. Checking routes');
                // check each route table
                for (const routeId of ROUTE_TABLE_ID) {
                    getRoutesList = await handleFailOver.describeRouteTableList(routeId);
                    await changeRoutePinToBoth(getRoutesList, routeId);
                }
            } else if (PIN_TO === PRIMARY_FORTIGATE_SEC_ENI || SECONDARY_FORTIGATE_SEC_ENI) {
                console.log(`PIN_TO is set to ${PIN_TO} checking routes.`);
                for (const routeId of ROUTE_TABLE_ID) {
                    getRoutesList = await handleFailOver.describeRouteTableList(routeId);
                    await changeRoutePinToInstance(getRoutesList, routeId);
                }
            }

        }
        response.setStatusCode(200)
        response.setHeader('content-type', 'application/json')
        response.send('')

    } else if (primaryHealthOK && !secondaryHealthOK) {
        console.log(`Fortigate ${PRIMARY_FORTIGATE_ID} reported healthy
                            ${SECONDARY_FORTIGATE_ID} reported unhealthy
                 `);
        for (const routeId of ROUTE_TABLE_ID) {
            console.log(`checking route ${routeId}`);
            getRoutesList = await handleFailOver.describeRouteTableList(routeId);
            for (const item of getRoutesList.RouteTables.RouteTable[0].RouteEntrys.RouteEntry) {
                if (item.InstanceId === SECONDARY_FORTIGATE_SEC_ENI) {
                    console.log(`Changing Route for destination ${item.DestinationCidrBlock}`);
                    // If secondaryRoute is found within Route table, change to be primary
                    try {
                        await handleFailOver.updateRoute(item, PRIMARY_FORTIGATE_SEC_ENI, routeId);
                    } catch (err) {
                        console.error(`Errror  Updating route:${err}`);
                    }
                }
            }
        }
        //Response is a buffer, expects a string.
        //Sending the response should start the termination of the function, which is the main goal.
        response.setStatusCode(200)
        response.setHeader('content-type', 'application/json')
        response.send('')

    } else if (!primaryHealthOK && secondaryHealthOK) {
        console.log(`Fortigate ${PRIMARY_FORTIGATE_ID} reported unhealthy
                           ${SECONDARY_FORTIGATE_ID} reported healthy
                `);

        for (const routeId of ROUTE_TABLE_ID) {
            console.log(`checking route ${routeId}`);
            getRoutesList = await handleFailOver.describeRouteTableList(routeId);
            for (const item of getRoutesList.RouteTables.RouteTable[0].RouteEntrys.RouteEntry) {
                console.log(PRIMARY_FORTIGATE_SEC_ENI, item.InstanceId);
                if (item.InstanceId === PRIMARY_FORTIGATE_SEC_ENI) {
                    console.log(`Changing Route for destination ${item.DestinationCidrBlock}`);
                    // If primary is found within Route table, change to be secondary
                    try {
                        await handleFailOver.updateRoute(
                            item,
                            SECONDARY_FORTIGATE_SEC_ENI,
                            routeId
                        );
                        await handleFailOver.updateRoute(item, PRIMARY_FORTIGATE_SEC_ENI, routeId);
                    } catch (err) {
                        console.error(`Error Updating route: ${err}`);
                    }
                }
            }
        }
        response.setStatusCode(200)
        response.setHeader('content-type', 'application/json')
        response.send('')
    }
    // Change Routes for PIN_TO = 'both'
    // This is the default single custom route per AZ approach. Each FortiGate acts as an egress point.
    // On return to a healthy state the both FortiGates will handle egress traffic.
    async function changeRoutePinToBoth(routesList, routeId): Promise<void> {
        if (routesList?.RouteTables?.RouteTable[0]?.RouteEntrys?.RouteEntry) {
            // Serialized because AliCloud can not handle more than one operation on a route
            // Table at a time.
            // The updateRoute/createRoute/removeRoute funcitons all have checks to see if a route is being operated on

            for (const item of routesList.RouteTables.RouteTable[0].RouteEntrys.RouteEntry) {
                if (item.RouteEntryName !== item.InstanceId) {
                    // Check to see if the Name is == to a defined Primary or secondary
                    // if so change that route. This will also avoid overwriting any non-FortiGate related values.
                    if (item.RouteEntryName === PRIMARY_FORTIGATE_SEC_ENI) {
                        console.log(
                            `Changing route ${item.DestinationCidrBlock} back to ${PRIMARY_FORTIGATE_SEC_ENI}`
                        );
                        await handleFailOver.updateRoute(item, PRIMARY_FORTIGATE_SEC_ENI, routeId);
                    } else if (item.RouteEntryName === SECONDARY_FORTIGATE_SEC_ENI) {
                        console.log(
                            `Changing route ${item.DestinationCidrBlock} back to ${SECONDARY_FORTIGATE_SEC_ENI}`
                        );
                        // Handle each request individually and wait for it to finish.
                        // Requests can not run in parallel.
                        await handleFailOver.updateRoute(
                            item,
                            SECONDARY_FORTIGATE_SEC_ENI,
                            routeId
                        );
                    }
                }
            }
        }
    }
    // Change Routes when PIN_TO is set to a single instance
    async function changeRoutePinToInstance(routesList, routeId): Promise<void> {
        for (const item of routesList.RouteTables.RouteTable[0].RouteEntrys.RouteEntry) {
            // Compare to ENI to make sure we only change FortiGate specific routes i.e no system generated routes
            if (
                item.InstanceId !== PIN_TO &&
                (item.InstanceId === PRIMARY_FORTIGATE_SEC_ENI ||
                    item.InstanceId === SECONDARY_FORTIGATE_SEC_ENI)
            ) {
                console.log(JSON.stringify(item));
                console.log(`PIN_TO is set,Changing Route for destination ${item.DestinationCidrBlock}
                to ${PIN_TO}
                `);
                // Serialized because AliCloud can not handle more than one operation on a route
                // Table at a time.
                // The updateRoute/createRoute/removeRoute funcitons all have checks to see if a route is being operated on

                await handleFailOver.updateRoute(item, PIN_TO, routeId);
            }
        }
    }
};

if (module === require.main) {
    exports.main(console.log);
}
