import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "./jwt-secret";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers["authorization"];
    if (!authHeader) throw new UnauthorizedException("No token provided");
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, getJwtSecret());
      req.user = decoded;
      return true;
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
  }
}
