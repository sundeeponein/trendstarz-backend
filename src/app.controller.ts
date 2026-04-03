import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Debug route to verify API prefix and deployment
  @Get("test")
  getTest(): object {
    return { success: true, message: "API is working and /api prefix is set." };
  }
}
