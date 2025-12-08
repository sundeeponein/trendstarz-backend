import { IsString, IsEmail, IsBoolean, IsArray, IsOptional, IsMongoId, IsUrl, ValidateNested, IsNumber, ArrayMaxSize, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';

export class LocationDto {
  @IsMongoId()
  state: string;
}

export class BrandLocationDto extends LocationDto {
  @IsUrl()
  @IsOptional()
  googleMapLink?: string;
}

export class ContactDto {
  @IsBoolean()
  whatsapp: boolean;

  @IsBoolean()
  email: boolean;

  @IsBoolean()
  call: boolean;
}

export class SocialMediaDto {
  @IsMongoId()
  platform: string;

  @IsString()
  handle: string;

  @IsString()
  tier: string;

  @IsNumber()
  followersCount: number;
}

export class InfluencerProfileDto {
  @IsString()
  password: string;

  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  phoneNumber: string;

  @IsString()
  username: string;

  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  profileImages: string[];

  @IsBoolean()
  isPremium: boolean;

  @IsArray()
  @IsMongoId({ each: true })
  categories: string[];

  @Type(() => LocationDto)
  @ValidateNested()
  location: LocationDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SocialMediaDto)
  socialMedia: SocialMediaDto[];

  @Type(() => ContactDto)
  @ValidateNested()
  contact: ContactDto;
}

export class BrandProfileDto {
  @IsString()
  password: string;

  @IsString()
  brandName: string;

  @IsEmail()
  email: string;

  @IsString()
  phoneNumber: string;

  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  brandLogo: string[];

  @IsBoolean()
  isPremium: boolean;

  @IsArray()
  @IsMongoId({ each: true })
  categories: string[];

  @Type(() => BrandLocationDto)
  @ValidateNested()
  location: BrandLocationDto;

  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @IsOptional()
  products?: string[];

  @Type(() => ContactDto)
  @ValidateNested()
  contact: ContactDto;
}
