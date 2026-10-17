import {
  IsString,
  IsDateString,
  IsEmail,
  IsBoolean,
  IsArray,
  IsOptional,
  IsMongoId,
  IsUrl,
  ValidateNested,
  IsNumber,
  IsInt,
  Min,
  Max,
  ArrayMaxSize,
} from "class-validator";
import { Type } from "class-transformer";

const CURRENT_YEAR = new Date().getFullYear();

export class ImageDto {
  @IsString()
  url!: string;

  @IsString()
  public_id!: string;
}

export class LocationDto {
  @IsMongoId()
  state!: string;
}

export class BrandLocationDto extends LocationDto {
  @IsUrl()
  @IsOptional()
  googleMapLink?: string;
}

export class ContactDto {
  @IsBoolean()
  whatsapp!: boolean;

  @IsBoolean()
  email!: boolean;

  @IsBoolean()
  call!: boolean;
}

export class ContentTypeDto {
  @IsString()
  name!: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsNumber()
  @IsOptional()
  price?: number;
}

export class SocialMediaDto {
  @IsString()
  platform!: string;

  @IsString()
  handle!: string;

  @IsString()
  @IsOptional()
  tier?: string;

  @IsNumber()
  @IsOptional()
  followersCount?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContentTypeDto)
  @IsOptional()
  contentTypes?: ContentTypeDto[];
}

export class InfluencerProfileDto {
  @IsNumber()
  promotionalPrice!: number;

  @IsString()
  password!: string;

  @IsString()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  phoneNumber!: string;

  @IsString()
  username!: string;

  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  profileImages!: ImageDto[];

  @IsBoolean()
  isPremium!: boolean;

  @IsArray()
  @IsMongoId({ each: true })
  categories!: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  creatorTypes?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  adminTags?: string[];

  @IsDateString()
  @IsOptional()
  dateOfBirth?: string;

  @IsString()
  @IsOptional()
  gender?: string;

  @IsArray()
  @IsMongoId({ each: true })
  languages!: string[];

  @Type(() => LocationDto)
  @ValidateNested()
  location!: LocationDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SocialMediaDto)
  socialMedia!: SocialMediaDto[];

  @Type(() => ContactDto)
  @ValidateNested()
  contact!: ContactDto;
}

export class BrandProfileDto {
  @IsNumber()
  promotionalPrice!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SocialMediaDto)
  @IsOptional()
  socialMedia?: SocialMediaDto[];

  @IsString()
  @IsOptional()
  googleMapAddress?: string;

  @IsString()
  password!: string;

  @IsString()
  brandName!: string;

  @IsString()
  @IsOptional()
  contactPersonName?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(CURRENT_YEAR)
  @IsOptional()
  foundedYear?: number;

  @IsString()
  @IsOptional()
  companySize?: string;

  @IsEmail()
  email!: string;

  @IsString()
  phoneNumber!: string;

  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  brandLogo!: ImageDto[];

  @IsBoolean()
  isPremium!: boolean;

  @IsArray()
  @IsMongoId({ each: true })
  categories!: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  adminTags?: string[];

  @IsArray()
  @IsMongoId({ each: true })
  languages!: string[];

  @Type(() => BrandLocationDto)
  @ValidateNested()
  location!: BrandLocationDto;

  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  @IsOptional()
  products?: ImageDto[];

  @Type(() => ContactDto)
  @ValidateNested()
  contact!: ContactDto;
}
