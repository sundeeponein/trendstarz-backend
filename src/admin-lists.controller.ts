import { Controller, Get, Post, Put, Delete, Body, Param, Patch } from '@nestjs/common';
import { CategoryModel, StateModel, SocialMediaModel, LanguageModel } from './database/schemas/profile.schemas';
import { TierModel } from './database/schemas/profile.schemas';

@Controller('admin')
export class AdminListsController {
  @Patch('states/:id')
  async patchState(@Param('id') id: string, @Body() body: any) {
    return StateModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch('categories/:id')
  async patchCategory(@Param('id') id: string, @Body() body: any) {
    return CategoryModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch('languages/:id')
  async patchLanguage(@Param('id') id: string, @Body() body: any) {
    return LanguageModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch('social-media/:id')
  async patchSocialMedia(@Param('id') id: string, @Body() body: any) {
    return SocialMediaModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Patch('tiers/:id')
  async patchTier(@Param('id') id: string, @Body() body: any) {
    return TierModel.findByIdAndUpdate(id, body, { new: true });
  }
  // Categories
  @Get('categories')
  async getCategories() {
  return CategoryModel.find().lean().limit(100);
  }
  @Post('categories')
  async addCategory(@Body() body: { name: string }) {
    return CategoryModel.create(body);
  }
  @Put('categories/:id')
  async updateCategoryFull(@Param('id') id: string, @Body() body: any) {
    return CategoryModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    return CategoryModel.findByIdAndDelete(id);
  }

  // States
  @Get('states')
  async getStates() {
  return StateModel.find().lean().limit(100);
  }
  @Post('states')
  async addState(@Body() body: { name: string }) {
    return StateModel.create(body);
  }
  @Put('states/:id')
  async updateStateFull(@Param('id') id: string, @Body() body: any) {
    return StateModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete('states/:id')
  async deleteState(@Param('id') id: string) {
    return StateModel.findByIdAndDelete(id);
  }


  // Languages
  @Get('languages')
  async getLanguages() {
  return LanguageModel.find().lean().limit(100);
  }
  @Post('languages')
  async addLanguage(@Body() body: { name: string }) {
    return LanguageModel.create(body);
  }
  @Put('languages/:id')
  async updateLanguageFull(@Param('id') id: string, @Body() body: any) {
    return LanguageModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete('languages/:id')
  async deleteLanguage(@Param('id') id: string) {
    return LanguageModel.findByIdAndDelete(id);
  }

  // Social Media
  @Get('social-media')
  async getSocialMedia() {
    // Return all social media entries with new fields
  return SocialMediaModel.find({}, { socialMedia: 1, handleName: 1, tier: 1, followersCount: 1 }).lean().limit(100);
  }
  @Post('social-media')
  async addSocialMedia(@Body() body: { socialMedia: string; handleName: string; tier: string; followersCount: number }) {
    // Create new social media entry with all fields
    return SocialMediaModel.create(body);
  }
  @Put('social-media/:id')
  async updateSocialMediaFull(@Param('id') id: string, @Body() body: any) {
    return SocialMediaModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete('social-media/:id')
  async deleteSocialMedia(@Param('id') id: string) {
    return SocialMediaModel.findByIdAndDelete(id);
  }

  @Post('batch-update-visibility')
  async batchUpdateVisibility(@Body() body: any) {
    // Each key is an array of {_id, showInFrontend}
    if (body.tiers) {
      for (const t of body.tiers) {
        await TierModel.findByIdAndUpdate(t._id, { showInFrontend: t.showInFrontend });
      }
    }
    if (body.socialMedia) {
      for (const s of body.socialMedia) {
        await SocialMediaModel.findByIdAndUpdate(s._id, { showInFrontend: s.showInFrontend });
      }
    }
    if (body.categories) {
      for (const c of body.categories) {
        await CategoryModel.findByIdAndUpdate(c._id, { showInFrontend: c.showInFrontend });
      }
    }
    if (body.languages) {
      for (const l of body.languages) {
        await LanguageModel.findByIdAndUpdate(l._id, { showInFrontend: l.showInFrontend });
      }
    }
    if (body.states) {
      for (const s of body.states) {
        await StateModel.findByIdAndUpdate(s._id, { showInFrontend: s.showInFrontend });
      }
    }
    return { message: 'Visibility updated' };
  }
}
