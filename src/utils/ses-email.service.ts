import { Injectable } from "@nestjs/common";
import * as AWS from "aws-sdk";
import type { AppEmailOptions } from "./app-email.service";

function createSesClient(): AWS.SES {
  return new AWS.SES({
    region: process.env.AWS_SES_REGION || "us-east-1",
    accessKeyId: process.env.AWS_SES_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY,
  });
}

export async function sendEmailSes({ to, subject, text, html }: AppEmailOptions) {
  const ses = createSesClient();
  const params = {
    Source:
      process.env.AWS_SES_FROM ||
      process.env.SES_EMAIL_FROM ||
      "no-reply@trendstarz.in",
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: text || "" },
        ...(html ? { Html: { Data: html } } : {}),
      },
    },
  };
  return new Promise((resolve, reject) => {
    ses.sendEmail(params, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

@Injectable()
export class SesEmailService {
  private ses: AWS.SES;

  constructor() {
    this.ses = createSesClient();
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
    return new Promise((resolve, reject) => {
      this.ses.sendEmail(params, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });
  }
}
