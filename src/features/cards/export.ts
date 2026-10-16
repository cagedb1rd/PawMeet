import { Pet, SocialCard } from "@/domain/schemas";
import { getImage } from "@/lib/storage/images";

export async function exportCard(p: Pet, c: SocialCard, share: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("浏览器不支持名片图片生成");
  const sections = [
    ["社交性格", c.traits.join(" · ")],
    ["喜欢的互动", c.likes.join(" · ")],
    ["不喜欢的行为", c.dislikes.join(" · ")],
    ["需要注意的习惯", c.cautions.join(" · ")],
    ["初次见面建议", c.meetingAdvice],
  ];
  const wrap = (value: string, max: number) => {
    ctx.font = "30px sans-serif";
    const lines: string[] = [];
    let line = "";
    for (const char of value || "尚未补充，请向主人确认") {
      if (char === "\n" || ctx.measureText(line + char).width > max) {
        lines.push(line);
        line = char === "\n" ? "" : char;
      } else line += char;
    }
    lines.push(line);
    return lines;
  };
  const content = sections.map(([label, value]) => ({
    label,
    lines: wrap(value, 900),
  }));
  canvas.height =
    520 + content.reduce((n, item) => n + 105 + item.lines.length * 46, 0);
  ctx.fillStyle = "#f7f5ee";
  ctx.fillRect(0, 0, 1080, canvas.height);
  ctx.fillStyle = "#e5ebdf";
  ctx.fillRect(0, 0, 1080, 355);
  const uploaded =
    p.photo.kind === "upload" ? await getImage(p.photo.imageId) : null;
  if (p.photo.kind === "upload" && !uploaded)
    throw Error("照片不可用，请主人补充后重新导出");
  const url = uploaded
    ? URL.createObjectURL(uploaded)
    : p.photo.kind === "static"
      ? p.photo.path
      : "";
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(68, 68, 220, 220, 36);
    ctx.clip();
    const side = Math.min(image.width, image.height);
    ctx.drawImage(
      image,
      (image.width - side) / 2,
      (image.height - side) / 2,
      side,
      side,
      68,
      68,
      220,
      220,
    );
    ctx.restore();
  } finally {
    if (uploaded) URL.revokeObjectURL(url);
  }
  ctx.fillStyle = "#284a3a";
  ctx.font = "24px sans-serif";
  ctx.fillText("PAWMEET / FRIENDSHIP NOTES", 330, 100);
  ctx.font = "bold 56px sans-serif";
  ctx.fillText(p.name, 330, 185, 670);
  ctx.font = "30px sans-serif";
  ctx.fillText(`${p.breed} · ${p.district}`, 330, 244, 670);
  ctx.font = "24px sans-serif";
  ctx.fillText("虚构宠物 · 主人已确认 · 手工填写", 330, 296);
  let y = 420;
  for (const item of content) {
    ctx.fillStyle = "#56745c";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText(item.label, 80, y);
    y += 54;
    ctx.fillStyle = "#29362e";
    ctx.font = "30px sans-serif";
    for (const line of item.lines) {
      ctx.fillText(line, 80, y);
      y += 46;
    }
    y += 51;
  }
  ctx.font = "24px sans-serif";
  ctx.fillStyle = "#626b62";
  ctx.fillText(
    "偏好仅供沟通参考，不是专业行为诊断或安全保证。",
    80,
    canvas.height - 70,
  );
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(Error("生成 PNG 失败"))),
      "image/png",
    ),
  );
  const file = new File([blob], `PawMeet-${p.name}.png`, { type: "image/png" });
  if (share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: `${p.name}的社交名片` });
    return;
  }
  const output = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = output;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(output), 10000);
}
