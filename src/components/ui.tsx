"use client";
import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ImagePlus, X, PawPrint, ArrowUpRight, MapPin } from "lucide-react";
import { ImageRef, Pet, sizeLabels } from "@/domain/schemas";
import {
  compressImage,
  getImage,
  removeImage,
  storeImage,
} from "@/lib/storage/images";

export function PetImage({
  image,
  alt,
  className = "",
}: {
  image: ImageRef;
  alt: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(
    null,
  );
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imageId = image.kind === "upload" ? image.imageId : null;
  useEffect(() => {
    if (!imageId) return;
    let disposed = false,
      url: string | undefined;
    getImage(imageId)
      .then((blob) => {
        if (!disposed && blob) {
          url = URL.createObjectURL(blob);
          setLoaded({ id: imageId, url });
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageId]);
  const src =
    image.kind === "static"
      ? image.path
      : loaded?.id === imageId
        ? loaded.url
        : null;
  if (!src || failedSrc === src)
    return (
      <div
        className={`image-fallback ${className}`}
        role="img"
        aria-label={`${alt}，照片暂不可用`}
      >
        <PawPrint />
        <span>照片待补充</span>
      </div>
    );
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailedSrc(src)}
    />
  );
}
export function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    ref.current?.showModal();
    const d = ref.current;
    return () => {
      d?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      className="dialog"
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button aria-label="关闭弹窗" className="icon-button" onClick={close}>
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Title({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <PawPrint size={32} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}
export function Unavailable({ children }: { children: React.ReactNode }) {
  return (
    <div className="unavailable">
      <span className="status-dot" />
      {children}
    </div>
  );
}
export function PetCard({
  pet,
  distance,
  selected,
  onSelect,
  own = false,
}: {
  pet: Pet;
  distance?: string;
  selected?: boolean;
  onSelect?: () => void;
  own?: boolean;
}) {
  return (
    <article
      className={`pet-card card ${selected ? "pet-selected" : ""}`}
      data-pet-id={pet.id}
    >
      <Link
        href={distance ? `/pets/${pet.id}/card` : `/pets/${pet.id}`}
        className="pet-card-main"
      >
        <div className="pet-photo">
          <PetImage image={pet.photo} alt={pet.name} />
          <span className="round-arrow">
            <ArrowUpRight size={18} />
          </span>
        </div>
        <div className="pet-info">
          <div className="row-between">
            <h3>{pet.name}</h3>
            <span className="muted">
              {pet.ageMonths === null
                ? "年龄未知"
                : pet.ageMonths < 12
                  ? `${pet.ageMonths}个月`
                  : `${Math.floor(pet.ageMonths / 12)}岁`}
            </span>
          </div>
          <p>
            {pet.breed} · {sizeLabels[pet.size]}
          </p>
          <div className="tags">
            {pet.temperamentTags.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
          <div className="location">
            <MapPin size={13} />
            {pet.city} · {pet.district}
          </div>
          {distance && (
            <p className="pet-distance">{distance} · 大致直线距离</p>
          )}
          <div className="tags">
            {pet.activityTags.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        </div>
      </Link>
      <div className="pet-actions">
        <Link href={`/pets/${pet.id}`}>档案</Link>
        {own ? (
          <Link href={`/me/pets/${pet.id}/edit`}>编辑档案</Link>
        ) : (
          <Link href={`/activities/new?recommendedPetId=${pet.id}`}>
            发起约伴
          </Link>
        )}
        {onSelect && (
          <button type="button" onClick={onSelect}>
            {selected ? "地图已选中" : "在地图查看"}
          </button>
        )}
      </div>
      {own ? (
        <Link className="pet-compare-link" href={`/pets/${pet.id}/card`}>
          查看社交名片 →
        </Link>
      ) : (
        <Link
          className="pet-compare-link"
          href={`/discover/compare?petId=${pet.id}`}
        >
          比较社交偏好 ↗
        </Link>
      )}
    </article>
  );
}
export function usePhotoDraft(initial: ImageRef[] = []) {
  const [images, setImages] = useState<ImageRef[]>(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const staged = useRef<string[]>([]),
    saved = useRef(false);
  useEffect(
    () => () => {
      if (!saved.current)
        staged.current.forEach((id) => {
          void removeImage(id).catch(() => {});
        });
    },
    [],
  );
  const add = async (files: FileList | null, max: number) => {
    if (!files?.length) return;
    setError("");
    if (files.length + images.length > max) {
      setError(`最多选择 ${max} 张照片，请先移除旧照片`);
      return;
    }
    setBusy(true);
    const next: ImageRef[] = [];
    try {
      for (const file of Array.from(files)) {
        const ref = await storeImage(await compressImage(file));
        if (ref.kind === "upload") staged.current.push(ref.imageId);
        next.push(ref);
      }
      setImages((prev) => [...prev, ...next]);
    } catch (e) {
      for (const ref of next)
        if (ref.kind === "upload") {
          await removeImage(ref.imageId).catch(() => {});
          staged.current = staged.current.filter((id) => id !== ref.imageId);
        }
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };
  const remove = (index: number) => {
    const ref = images[index];
    if (ref.kind === "upload" && staged.current.includes(ref.imageId)) {
      void removeImage(ref.imageId).catch(() => {});
      staged.current = staged.current.filter((id) => id !== ref.imageId);
    }
    setImages(images.filter((_, i) => i !== index));
  };
  return {
    images,
    busy,
    error,
    add,
    remove,
    markSaved: () => {
      saved.current = true;
    },
  };
}
export function PhotoPicker({
  draft,
  max,
}: {
  draft: ReturnType<typeof usePhotoDraft>;
  max: number;
}) {
  return (
    <div className="photo-picker">
      <div className="photo-previews">
        {draft.images.map((image, i) => (
          <div key={image.kind === "static" ? image.path : image.imageId}>
            <PetImage image={image} alt={`已选照片 ${i + 1}`} />
            <button
              type="button"
              aria-label={`移除照片 ${i + 1}`}
              disabled={draft.busy}
              onClick={() => draft.remove(i)}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
      {draft.images.length < max && (
        <label className="upload">
          <ImagePlus size={22} />
          <span>{draft.busy ? "正在压缩与保存…" : "选择照片"}</span>
          <input
            aria-label="上传照片"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple={max > 1}
            disabled={draft.busy}
            onChange={(e) => {
              void draft.add(e.target.files, max);
              e.target.value = "";
            }}
          />
        </label>
      )}
      <p className="form-hint">
        JPEG / PNG / WebP，原图
        ≤8MiB。自动压缩，照片只保存在当前浏览器。宠物可不上传，使用默认照片。
      </p>
      {draft.error && (
        <p role="alert" className="field-error">
          {draft.error}
        </p>
      )}
    </div>
  );
}
export const formatTime = (iso: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
export function useUnsaved() {
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    const click = (e: MouseEvent) => {
      if (
        dirty &&
        (e.target as Element).closest("a[href]") &&
        !window.confirm("表单尚未保存，确定离开吗？")
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const switchIdentity = (e: Event) => {
      if (
        dirty &&
        !window.confirm("表单尚未保存，切换身份会丢弃草稿，确定切换吗？")
      )
        e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    window.addEventListener("pawmeet-before-switch", switchIdentity);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
      window.removeEventListener("pawmeet-before-switch", switchIdentity);
    };
  }, [dirty]);
  return { dirty, setDirty };
}
