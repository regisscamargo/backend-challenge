import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { join } from "node:path";

@Controller()
export class DemoController {
  @Get("demo")
  show(@Res() response: Response): void {
    response.sendFile(join(process.cwd(), "docs", "demo.html"));
  }
}
