import * as path from "path";

import { Command } from "../command";
import { Options } from "../options";
import { DataConnectEmulator } from "../emulator/dataconnectEmulator";
import { needProjectId } from "../projectUtils";
import { load } from "../dataconnect/load";
import { readFirebaseJson } from "../dataconnect/fileUtils";
import { logger } from "../logger";

export const command = new Command("dataconnect:sdk:generate")
  .description("generates typed SDKs for your Data Connect connectors")
  .action(async (options: Options) => {
    const projectId = needProjectId(options);

    const services = readFirebaseJson(options.config);
    for (const service of services) {
      let configDir = service.source;
      if (!path.isAbsolute(configDir)) {
        const cwd = options.cwd || process.cwd();
        configDir = path.resolve(path.join(cwd), configDir);
      }
      const serviceInfo = await load(projectId, service.location, configDir);
      for (const conn of serviceInfo.connectorInfo) {
        const output = await DataConnectEmulator.generate({
          configDir,
          locationId: service.location,
          connectorId: conn.connectorYaml.connectorId,
        });
        logger.info(output);
        logger.info(`Generated SDKs for ${conn.connectorYaml.connectorId}`);
      }
    }
  });
