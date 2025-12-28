export class ImageDto {
  @IsString()
  url: string;

  @IsString()
  public_id: string;
}
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
  @IsNumber()
  promotionalPrice: number;
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
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  profileImages: ImageDto[];

  @IsBoolean()
  isPremium: boolean;

  @IsArray()
  @IsMongoId({ each: true })
  categories: string[];

  @IsArray()
  @IsMongoId({ each: true })
  languages: string[];

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
  @IsNumber()
  promotionalPrice: number;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SocialMediaDto)
  @IsOptional()
  socialMedia?: SocialMediaDto[];

  @IsString()
  @IsOptional()
  googleMapAddress?: string;
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
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  brandLogo: ImageDto[];

  @IsBoolean()
  isPremium: boolean;

  @IsArray()
  @IsMongoId({ each: true })
  categories: string[];

  @IsArray()
  @IsMongoId({ each: true })
  languages: string[];

  @Type(() => BrandLocationDto)
  @ValidateNested()
  location: BrandLocationDto;

  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  @IsOptional()
  products?: ImageDto[];

  @Type(() => ContactDto)
  @ValidateNested()
  contact: ContactDto;
}
