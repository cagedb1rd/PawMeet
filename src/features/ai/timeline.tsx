"use client";
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  LoaderCircle,
} from "lucide-react";
import {
  StepStatus,
  TimelineStep,
  compactSteps,
  formatDuration,
  isParallel,
  statusLabels,
} from "@/lib/ai/timeline";

const icons: Record<StepStatus, typeof CircleCheck> = {
  running: LoaderCircle,
  done: CircleCheck,
  empty: CircleMinus,
  error: CircleAlert,
  cancelled: CircleX,
};
function StepLine({
  step,
  parallel,
}: {
  step: TimelineStep;
  parallel: boolean;
}) {
  const Icon = icons[step.status];
  const duration = formatDuration(step);
  return (
    <>
      <Icon className="timeline-icon" size={16} aria-hidden />
      <span className="timeline-label">{step.label}</span>
      {parallel && <span className="timeline-badge">并行</span>}
      <span className="timeline-status">{statusLabels[step.status]}</span>
      {duration && <span className="timeline-duration">{duration}</span>}
      {step.summary && <span className="timeline-summary">{step.summary}</span>}
    </>
  );
}
/** Only steps that actually happened; summaries are program-written, never model reasoning. */
export function CompanionTimeline({ steps }: { steps: TimelineStep[] }) {
  if (!steps.length) return null;
  const compact = compactSteps(steps);
  return (
    <section
      className="companion-timeline"
      aria-label="工具调用时间线"
      data-testid="companion-timeline"
    >
      <h3>执行过程</h3>
      <ol className="timeline-list">
        {compact.map((s) => (
          <li
            key={s.id}
            className={`timeline-step is-${s.status}`}
            data-testid="timeline-step"
            data-kind={s.kind}
            data-status={s.status}
          >
            <StepLine step={s} parallel={isParallel(steps, s)} />
          </li>
        ))}
      </ol>
      <details className="timeline-details">
        <summary>
          查看完整过程（含 {steps.filter((s) => s.kind === "plan").length}{" "}
          次模型请求）
        </summary>
        <ol className="timeline-list">
          {steps.map((s) => (
            <li
              key={s.id}
              className={`timeline-step is-${s.status}`}
              data-testid="timeline-detail"
              data-kind={s.kind}
            >
              <StepLine step={s} parallel={isParallel(steps, s)} />
            </li>
          ))}
        </ol>
        <p className="form-hint">
          只列出实际发生的模型请求与浏览器本地只读工具调用，摘要由程序根据真实结果生成，不含模型推理内容；过程不会保存。
        </p>
      </details>
    </section>
  );
}
