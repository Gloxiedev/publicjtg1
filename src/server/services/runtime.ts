import {
  createServerContainer,
  startContainer,
  stopContainer,
  restartContainer,
  killContainer,
  deleteContainer,
  getContainerStatus,
  getContainerStats,
  getContainerLogs,
  attachContainerSocket,
  sendContainerCommand
} from "./docker.js";

import {
  createLocalServer,
  startLocalServer,
  stopLocalServer,
  killLocalServer,
  restartLocalServer,
  deleteLocalServer,
  getLocalServerStatus,
  getLocalServerStats,
  getLocalServerLogs,
  attachLocalServerSocket,
  sendLocalServerCommand
} from "./local.js";

import { getRuntimeProvider } from "./runtimeFactory.js";
import { panelEvents } from "../events.js";

const wings = getRuntimeProvider("wings");

const isWings = (server: any) => (server?.runtimeType || "wings") === "wings";
const nodeIdFor = (server: any, explicit?: string) => explicit || server?.nodeId;

export const createServerRuntime = async (serverData: any, nodeId?: string) => {
  if (serverData.runtimeType === "local") {
    return await createLocalServer(serverData);
  }
  if (isWings(serverData)) {
    return await wings.createServer({ ...serverData, nodeId: nodeIdFor(serverData, nodeId) });
  }
  return await createServerContainer(serverData, nodeId);
};

export const startServerRuntime = async (server: any) => {
  if (server.runtimeType === "local") {
    return await startLocalServer(server.id, server);
  }
  if (isWings(server)) {
    return await wings.startServer(server.id);
  }
  return await startContainer(server.containerId, server.nodeId);
};

export const stopServerRuntime = async (server: any) => {
  if (server.runtimeType === "local") {
    return await stopLocalServer(server.id);
  }
  if (isWings(server)) {
    return await wings.stopServer(server.id);
  }
  return await stopContainer(server.containerId, server.nodeId);
};

export const restartServerRuntime = async (server: any) => {
  if (server.runtimeType === "local") {
    return await restartLocalServer(server.id, server);
  }
  if (isWings(server)) {
    return await wings.restartServer(server.id);
  }
  return await restartContainer(server.containerId, server.nodeId);
};

export const killServerRuntime = async (server: any) => {
  if (server.runtimeType === "local") {
    return await killLocalServer(server.id);
  }
  if (isWings(server)) {
    return await wings.killServer(server.id);
  }
  return await killContainer(server.containerId, server.nodeId);
};

export const deleteServerRuntime = async (server: any) => {
  if (server.runtimeType === "local") {
    return await deleteLocalServer(server.id);
  }
  if (isWings(server)) {
    return await wings.deleteServer(server.id);
  }
  return await deleteContainer(server.containerId, server.nodeId);
};

export const getServerRuntimeStatus = async (server: any) => {
  if (server.runtimeType === "local") {
    return await getLocalServerStatus(server.id);
  }
  if (isWings(server)) {
    return await wings.getServerStatus(server.id);
  }
  return await getContainerStatus(server.containerId, server.nodeId);
};

export const getServerRuntimeStats = async (server: any) => {
  if (server.runtimeType === "local") {
    return await getLocalServerStats(server.id);
  }
  if (isWings(server)) {
    return await wings.getServerStats(server.id);
  }
  return await getContainerStats(server.containerId, server.nodeId);
};

export const getServerRuntimeLogs = async (server: any) => {
  if (server.runtimeType === "local") {
    return await getLocalServerLogs(server.id);
  }
  if (isWings(server)) {
    return await wings.getConsoleLogs(server.id);
  }
  return await getContainerLogs(server.containerId, server.nodeId);
};

export const attachServerRuntimeSocket = async (server: any, serverId: string) => {
  if (server.runtimeType === "local") {
    return attachLocalServerSocket(server.id, serverId);
  }
  if (isWings(server)) {
    return await wings.subscribeToConsole(server.id, (chunk: string) => {
      if (typeof chunk === "string" && chunk.length) {
        panelEvents.emit("log", serverId, chunk);
      }
    });
  }
  return await attachContainerSocket(server.containerId, serverId, server.nodeId);
};

export const sendServerRuntimeCommand = async (server: any, command: string) => {
  if (server.runtimeType === "local") {
    return await sendLocalServerCommand(server.id, command);
  }
  if (isWings(server)) {
    return await wings.sendConsoleCommand(server.id, command);
  }
  return await sendContainerCommand(server.containerId, command, server.nodeId);
};
