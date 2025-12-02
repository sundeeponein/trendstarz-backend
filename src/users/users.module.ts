import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { CloudinaryService } from '../cloudinary.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, CloudinaryService],
})
export class UsersModule {}
