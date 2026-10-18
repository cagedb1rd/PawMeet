// datetime-local is explicitly interpreted in Shanghai rather than the device timezone.
export function shanghaiTime(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value)
    throw new Error("请填写完整的北京时间");
  return new Date(`${value}:00+08:00`).toISOString();
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
