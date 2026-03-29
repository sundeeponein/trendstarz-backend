import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  MaxLength,
} from "class-validator";
import { Transform } from "class-transformer";

export class LoginDto {
  @IsEmail({}, { message: "Please provide a valid email address." })
  @Transform(({ value }: { value: string }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  email: string;

  @IsString()
  @IsNotEmpty({ message: "Password is required." })
  password: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: "Please provide a valid email address." })
  @Transform(({ value }: { value: string }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty({ message: "Reset token is required." })
  token: string;

  @IsString()
  @MinLength(8, { message: "Password must be at least 8 characters." })
  @MaxLength(128, { message: "Password must not exceed 128 characters." })
  newPassword: string;
}

export class SendEmailVerificationDto {
  @IsEmail({}, { message: "Please provide a valid email address." })
  @Transform(({ value }: { value: string }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  email: string;
}
