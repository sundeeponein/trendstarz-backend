import { newCampaignInviteTemplate, openCampaignLiveTemplate } from "./campaign.templates";
import { paymentProofAdminTemplate, paymentRejectedTemplate } from "./payment.templates";

const EVIL = '<a href="https://fake.example">Claim payment</a>';

describe("emails never turn user-typed text into HTML", () => {
  it("escapes brand names and campaign titles in the html, keeps them readable in text/subject", () => {
    const t = newCampaignInviteTemplate({ recipientName: "Asha", senderName: EVIL, campaignTitle: "H&M <b>sale</b>", dashboardUrl: "https://trendstarz.in/x" });
    expect(t.html).not.toContain('<a href="https://fake.example">');
    expect(t.html).toContain("&lt;a href=&quot;https://fake.example&quot;&gt;");
    expect(t.html).toContain("H&amp;M &lt;b&gt;sale&lt;/b&gt;");
    expect(t.text).toContain("H&M <b>sale</b>"); // plain text stays as typed
  });

  it("covers derived html parts and payment emails too", () => {
    const live = openCampaignLiveTemplate({ influencerName: "A", campaignTitle: "T", brandName: EVIL, location: "<i>Pune</i>", campaignUrl: "https://trendstarz.in/c" } as any);
    expect(live.html).not.toContain('<a href="https://fake.example">');
    expect(live.html).not.toContain("<i>Pune</i>");
    const proof = paymentProofAdminTemplate({ campaignTitle: EVIL, utrNumber: "<script>x</script>", recipientCount: 1, adminUrl: "https://trendstarz.in/a" } as any);
    expect(proof.html).not.toContain("<script>");
    const rejected = paymentRejectedTemplate({ brandName: "B", reason: EVIL, resubmitUrl: "https://trendstarz.in/r" } as any);
    expect(rejected.html).not.toContain('<a href="https://fake.example">');
  });
});
