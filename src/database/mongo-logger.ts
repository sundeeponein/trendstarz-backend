import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Injectable()
export class MongoLogger {
  constructor(@InjectConnection() private readonly connection: Connection) {
    this.connection.on('connected', () => {
      console.log('🔥 MongoDB Connected Successfully!');
    });

    this.connection.on('error', (err) => {
      console.log('❌ MongoDB Connection Error:', err.message);
    });
  }
}
