import { Injectable } from "@nestjs/common";
import * as AWS from "aws-sdk";

@Injectable()
export class SesEmailService {
  private ses: AWS.SES;

  constructor() {
    this.ses = new AWS.SES({
      region: process.env.AWS_SES_REGION || "us-east-1",
      accessKeyId: process.env.AWS_SES_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY,
    });
  }

  async sendMail(to: string, subject: string, text: string, html?: string) {
    const params = {
      Source: process.env.SES_EMAIL_FROM || "no-reply@trendstarz.in",
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: {
          Text: { Data: text },
          ...(html ? { Html: { Data: html } } : {}),
        },
      },
    };
    return this.ses.sendEmail(params).promise();
  }
}
