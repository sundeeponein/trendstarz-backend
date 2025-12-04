import { Controller, Get } from '@nestjs/common';
import { TierModel, LanguageModel, CategoryModel, StateModel, DistrictModel, SocialMediaModel } from './database/schemas/profile.schemas';

@Controller('tiers')
export class TiersController {
  @Get()
    async getAll() {
      const tiers = await TierModel.find({});
      return tiers.length ? tiers : [];
    }
}

@Controller('languages')
export class LanguagesController {
  @Get()
  async getAll() {
    return LanguageModel.find({});
  }
}

@Controller('categories')
export class CategoriesController {
  @Get()
  async getAll() {
    return CategoryModel.find({});
  }
}

@Controller('states')
export class StatesController {
  @Get()
  async getAll() {
    return StateModel.find({});
  }
}

@Controller('districts')
export class DistrictsController {
  @Get()
  async getAll() {
    return DistrictModel.find({}).populate('state');
  }
}

@Controller('social-media')
export class SocialMediaController {
  @Get()
  async getAll() {
    return SocialMediaModel.find({});
  }
}
