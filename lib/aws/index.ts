import * as ec2 from "@aws-sdk/client-ec2";
import * as serviceQuotas from "@aws-sdk/client-service-quotas";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AWSProxyManager {
  private ec2Client: ec2.EC2Client;
  private serviceQuotasClient: serviceQuotas.ServiceQuotasClient;
  private readonly INSTANCE_TYPE = "t2.micro"; // 1 vCPU
  private readonly INSTANCE_VCPU_COUNT = 1;
  private maxvCPUs: number = 20;
  private maxInstances: number = Math.floor(this.maxvCPUs / this.INSTANCE_VCPU_COUNT);
  private readonly INSTANCE_NAME = "proxy";
  private readonly AMI_ID = "ami-0b40807e5dc1afecf"; // Debian 12
  private readonly SECURITY_GROUP = "proxy-swarm";
  private readonly KEY_NAME = "proxy-swarm";
  private readonly USER_DATA_FILE = path.join(__dirname, "../../scripts/startup.sh");
  private readonly KEY_FILE_PATH = path.join(__dirname, `${this.KEY_NAME}.pem`);
  private readonly PING_INTERVAL_MS = 1000;

  private constructor() {
    this.ec2Client = new ec2.EC2Client({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
    this.serviceQuotasClient = new serviceQuotas.ServiceQuotasClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

  static async create(): Promise<AWSProxyManager> {
    const instance = new AWSProxyManager();
    await instance.getMaxvCPUs();
    return instance;
  }

  /**
   * Check if key pair exists and create it if it doesn't
   */
  private async ensureKeyPair(): Promise<void> {
    console.log(`Ensuring key pair "${this.KEY_NAME}" exists...`);
    try {
      // Check if key pair exists
      const describeCommand = new ec2.DescribeKeyPairsCommand({
        KeyNames: [this.KEY_NAME],
      });

      try {
        await this.ec2Client.send(describeCommand);

        return;
      } catch (error) {
        console.log(`Creating key pair "${this.KEY_NAME}"...`);
      }

      // Generate key pair using ssh-keygen
      const tempKeyPath = path.join(__dirname, `${this.KEY_NAME}-temp`);
      const { execSync } = await import("child_process");

      // Generate the key pair
      execSync(`ssh-keygen -t ed25519 -f ${tempKeyPath} -N "" -q`);

      // Read the public key
      const publicKeyOpenSSH = fs.readFileSync(`${tempKeyPath}.pub`, "utf8");

      // Create key pair in AWS
      const createCommand = new ec2.ImportKeyPairCommand({
        KeyName: this.KEY_NAME,
        PublicKeyMaterial: Buffer.from(publicKeyOpenSSH),
      });

      await this.ec2Client.send(createCommand);

      // Move the private key to the final location
      fs.renameSync(tempKeyPath, this.KEY_FILE_PATH);
      fs.chmodSync(this.KEY_FILE_PATH, 0o600); // Set proper permissions

      // Clean up the temporary .pub file
      fs.unlinkSync(`${tempKeyPath}.pub`);

      console.log(
        `Created key pair "${this.KEY_NAME}" and saved private key to ${this.KEY_FILE_PATH}`,
      );
    } catch (error) {
      console.error("Error creating key pair:", error);
      throw error;
    }
  }

  /**
   * Check if security group exists and create it if it doesn't
   * @returns The security group ID
   */
  private async ensureSecurityGroup(): Promise<string> {
    console.log(`Ensuring security group "${this.SECURITY_GROUP}" exists...`);
    try {
      // Check if security group exists
      const describeCommand = new ec2.DescribeSecurityGroupsCommand({
        GroupNames: [this.SECURITY_GROUP],
      });

      try {
        const response = await this.ec2Client.send(describeCommand);
        if (response.SecurityGroups && response.SecurityGroups.length > 0) {
          return response.SecurityGroups[0].GroupId!;
        }
      } catch (error) {
        console.log(`Creating security group "${this.SECURITY_GROUP}"...`);
      }

      // Create security group
      const createCommand = new ec2.CreateSecurityGroupCommand({
        GroupName: this.SECURITY_GROUP,
        Description: "Security group for proxy instances",
      });

      const createResponse = await this.ec2Client.send(createCommand);
      const groupId = createResponse.GroupId!;

      // Add inbound rules
      const authorizeCommand = new ec2.AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
          {
            IpProtocol: "tcp",
            FromPort: 8081,
            ToPort: 8081,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
        ],
      });

      await this.ec2Client.send(authorizeCommand);
      console.log(`Created security group "${this.SECURITY_GROUP}" with ID ${groupId}`);
      return groupId;
    } catch (error) {
      console.error("Error creating security group:", error);
      throw error;
    }
  }

  /**
   * Wait for instances to be running
   * @param instanceIds Array of instance IDs to wait for
   */
  private async waitForInstancesRunning(instanceIds: string[]): Promise<void> {
    console.log(`Waiting for instances to be running...`);
    while (true) {
      const describeCommand = new ec2.DescribeInstancesCommand({
        Filters: [
          {
            Name: "instance-id",
            Values: instanceIds,
          },
        ],
      });

      const response = await this.ec2Client.send(describeCommand);
      const allRunning = response.Reservations?.every((reservation) =>
        reservation.Instances?.every((instance) => instance.State?.Name === "running"),
      );

      if (allRunning) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, this.PING_INTERVAL_MS));
    }
  }

  /**
   * Start AWS proxy instances
   * @param instanceCount Number of instances to launch (default: max instances)
   * @returns Array of public IP addresses of the launched instances
   */
  async startProxies(instanceCount: number = this.maxInstances): Promise<string[]> {
    try {
      await this.ensureKeyPair();
      await this.ensureSecurityGroup();

      const userData = fs.readFileSync(this.USER_DATA_FILE, "utf8");

      const command = new ec2.RunInstancesCommand({
        ImageId: this.AMI_ID,
        MinCount: instanceCount,
        MaxCount: instanceCount,
        InstanceType: this.INSTANCE_TYPE,
        SecurityGroups: [this.SECURITY_GROUP],
        KeyName: this.KEY_NAME,
        UserData: Buffer.from(userData).toString("base64"),
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              {
                Key: "Name",
                Value: this.INSTANCE_NAME,
              },
            ],
          },
        ],
      });

      const response = await this.ec2Client.send(command);
      const instanceIds = response.Instances?.map((instance) => instance.InstanceId!) || [];

      console.log(`Launched ${instanceCount} instances: ${instanceIds.join(", ").blue}`);

      await this.waitForInstancesRunning(instanceIds);

      const publicIps = await this.listProxies();
      return publicIps;
    } catch (error) {
      console.error("Error launching instances:", error);
      throw error;
    }
  }

  /**
   * List all running proxy instances and their public IPs
   * @returns Array of public IP addresses
   */
  async listProxies(): Promise<string[]> {
    try {
      const command = new ec2.DescribeInstancesCommand({
        Filters: [
          {
            Name: "tag:Name",
            Values: [this.INSTANCE_NAME],
          },
          {
            Name: "instance-state-name",
            Values: ["running"],
          },
        ],
      });

      const response = await this.ec2Client.send(command);
      const publicIps: string[] = [];

      response.Reservations?.forEach((reservation: ec2.Reservation) => {
        reservation.Instances?.forEach((instance: ec2.Instance) => {
          if (instance.PublicIpAddress) {
            publicIps.push(instance.PublicIpAddress);
          }
        });
      });

      // Write to .proxies file (matching bash script behavior)
      fs.writeFileSync(".proxies", publicIps.join("\n"));

      return publicIps;
    } catch (error) {
      console.error("Error listing proxies:", error);
      throw error;
    }
  }

  /**
   * Terminate all proxy instances
   */
  async terminateProxies(): Promise<void> {
    console.log(`Terminating all proxy instances...`);
    try {
      // First, get all instance IDs
      const describeCommand = new ec2.DescribeInstancesCommand({
        Filters: [
          {
            Name: "tag:Name",
            Values: [this.INSTANCE_NAME],
          },
          {
            Name: "instance-state-name",
            Values: ["running", "pending", "stopped"],
          },
        ],
      });

      const describeResponse = await this.ec2Client.send(describeCommand);
      const instanceIds: string[] = [];

      describeResponse.Reservations?.forEach((reservation: ec2.Reservation) => {
        reservation.Instances?.forEach((instance: ec2.Instance) => {
          if (instance.InstanceId) {
            instanceIds.push(instance.InstanceId);
          }
        });
      });

      if (instanceIds.length === 0) {
        console.log(`No instances found with name "${this.INSTANCE_NAME}"`);
        return;
      }

      // Terminate the instances
      const terminateCommand = new ec2.TerminateInstancesCommand({
        InstanceIds: instanceIds,
      });

      await this.ec2Client.send(terminateCommand);
      console.log(`Terminated instances: ${instanceIds.join(", ").red}`);
    } catch (error) {
      console.error("Error terminating instances:", error);
      throw error;
    }
  }

  /**
   * List available Debian AMIs
   */
  async listImages(): Promise<void> {
    try {
      const command = new ec2.DescribeImagesCommand({
        Filters: [
          {
            Name: "name",
            Values: ["*debian*"],
          },
        ],
      });

      const response = await this.ec2Client.send(command);
      console.table(response.Images);
    } catch (error) {
      console.error("Error listing images:", error);
      throw error;
    }
  }

  /**
   * Get the maximum allowed running vCPUs for the AWS account
   * @returns The maximum number of running vCPUs allowed
   */
  async getMaxvCPUs(): Promise<number> {
    try {
      // TODO: Get all runnings instances and calculate the max additional vCPUs
      const command = new serviceQuotas.GetServiceQuotaCommand({
        ServiceCode: "ec2",
        QuotaCode: "L-1216C47A", // Running On-Demand EC2 instances
      });
      const response = await this.serviceQuotasClient.send(command);
      const maxvCPUs = response.Quota?.Value || this.maxvCPUs;
      this.maxvCPUs = maxvCPUs;
      this.maxInstances = Math.floor(maxvCPUs / this.INSTANCE_VCPU_COUNT);
      return maxvCPUs;
    } catch (error) {
      console.error("Error getting EC2 vCPU limit:", error);
      throw error;
    }
  }
}

// Export a singleton instance
export const awsProxyManager = await AWSProxyManager.create();
