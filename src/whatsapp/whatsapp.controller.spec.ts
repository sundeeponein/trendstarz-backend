import { WhatsAppWebhookController } from "./whatsapp.controller";

function fakeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.type = () => res;
  res.send = (b: any) => ((res.body = b), res);
  return res;
}

describe("WhatsApp webhook verification", () => {
  const controller = new (WhatsAppWebhookController as any)();
  const original = process.env.WHATSAPP_VERIFY_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
    else process.env.WHATSAPP_VERIFY_TOKEN = original;
  });

  it("refuses everything when no verify token is configured (even a request with no token)", () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    const res = fakeRes();
    controller.verify({ "hub.mode": "subscribe", "hub.challenge": "<script>x</script>" }, res);
    expect(res.statusCode).toBe(403);
  });

  it("echoes the challenge only for the right token", () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "s3cret";
    const wrong = fakeRes();
    controller.verify({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" }, wrong);
    expect(wrong.statusCode).toBe(403);
    const right = fakeRes();
    controller.verify({ "hub.mode": "subscribe", "hub.verify_token": "s3cret", "hub.challenge": "123" }, right);
    expect(right.statusCode).toBe(200);
    expect(right.body).toBe("123");
  });
});
