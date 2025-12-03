// Sample NestJS controller for config endpoints
import { Controller, Get, Patch, Body, Param } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Controller('api')
export class ConfigController {
  constructor(
    @InjectModel('State') private stateModel: Model<any>,
    @InjectModel('Category') private categoryModel: Model<any>,
    @InjectModel('Language') private languageModel: Model<any>,
    @InjectModel('Tier') private tierModel: Model<any>,
    @InjectModel('SocialMedia') private socialMediaModel: Model<any>
  ) {}

  @Get('states')
  async getStates() {
    return this.stateModel.find({});
  }

  @Patch('states/:id')
  async updateState(@Param('id') id: string, @Body() update: any) {
    return this.stateModel.findByIdAndUpdate(id, update, { new: true });
  }

  @Get('categories')
  async getCategories() {
    return this.categoryModel.find({});
  }

  @Patch('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() update: any) {
    return this.categoryModel.findByIdAndUpdate(id, update, { new: true });
  }

  @Get('languages')
  async getLanguages() {
    return this.languageModel.find({});
  }

  @Patch('languages/:id')
  async updateLanguage(@Param('id') id: string, @Body() update: any) {
    return this.languageModel.findByIdAndUpdate(id, update, { new: true });
  }

  @Get('tiers')
  async getTiers() {
    return this.tierModel.find({});
  }

  @Patch('tiers/:id')
  async updateTier(@Param('id') id: string, @Body() update: any) {
    return this.tierModel.findByIdAndUpdate(id, update, { new: true });
  }

  @Get('social-media')
  async getSocialMedia() {
    return this.socialMediaModel.find({});
  }

  @Patch('social-media/:id')
  async updateSocialMedia(@Param('id') id: string, @Body() update: any) {
    return this.socialMediaModel.findByIdAndUpdate(id, update, { new: true });
  }
}
