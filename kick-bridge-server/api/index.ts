import type { IncomingMessage, ServerResponse } from "node:http";
import { handleIncomingRequest } from "../src/remote-bridge/main.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleIncomingRequest(req, res);
}
