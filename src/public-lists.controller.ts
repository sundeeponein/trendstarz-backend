import { Controller, Get } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Controller('tiers')
export class TiersController {
  constructor(@InjectModel('Tier') private readonly tierModel: Model<any>) {}

  @Get()
  async getAll() {
    const tiers = await this.tierModel.find({}).lean().limit(100);
    return tiers.length ? tiers : [];
  }
}

@Controller('languages')
export class LanguagesController {
  constructor(@InjectModel('Language') private readonly languageModel: Model<any>) {}

  @Get()
  async getAll() {
    const languages = await this.languageModel.find({}).lean().limit(100);
    return languages.length ? languages : [];
  }
}

@Controller('categories')
export class CategoriesController {
  constructor(@InjectModel('Category') private readonly categoryModel: Model<any>) {}

  @Get()
  async getAll() {
    const categories = await this.categoryModel.find({}).lean().limit(100);
    return categories.length ? categories : [];
  }
}

@Controller('states')
export class StatesController {
  constructor(@InjectModel('State') private readonly stateModel: Model<any>) {}

  @Get()
  async getAll() {
    const states = await this.stateModel.find({}).lean().limit(100);
    return states.length ? states : [];
  }
}

@Controller('social-media')
export class SocialMediaController {
  constructor(@InjectModel('SocialMedia') private readonly socialMediaModel: Model<any>) {}

  @Get()
  async getAll() {
    const socials = await this.socialMediaModel.find({}).lean().limit(100);
    return socials.length ? socials : [];
  }
}
