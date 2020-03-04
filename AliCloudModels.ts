/** AliCloud Types  */

/**
 * AliCloud Instance/Interfaces
 */

export interface NetworkInterfaces {
    NetworkInterface?: NetworkInterfaceEntity[] | null;
}
export interface NetworkInterfaceEntity {
    MacAddress?: string;
    PrimaryIpAddress: string;
    NetworkInterfaceId: string;
}
export interface InstanceEntity {
    NetworkInterfaces: NetworkInterfaces;
    InstanceId: string;
}
export interface Instances {
    Instance?: InstanceEntity[] | null;
}

export interface AliCloudInstance {
    Instances: Instances;
}
/**
 * AliCloud Routes/RouteTable
 */

export interface RouteEntry {
    RouteEntryName?: string;
    NextHopId?: string;
    RouteTableId?: string;
    DestinationCidrBlock?: string;
    InstanceId?: string;
    Status?: string;
}
export interface RouteEntrys {
    RouteEntry: RouteEntry[];
}
export interface RouteTable {
    RouteEntrys: RouteEntrys;
}
export interface RouteTables {
    RouteTable: RouteTable[];
}
export interface AliCloudRoutesList {
    RouteTables?: RouteTables;
}
