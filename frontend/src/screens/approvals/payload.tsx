import { Copy, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";

import schemas from "@/api/action-schemas.json";
import type { Member } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { date } from "@/lib/format";

/** The JSON schemas exported from the API's payload models (`tenderline action-schemas`). */
interface PropertySchema {
  type: "string" | "array" | "integer";
  title?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: { type: "integer"; minimum?: number; maximum?: number };
  default?: unknown;
}
interface ActionSchema {
  properties: Record<string, PropertySchema>;
  required?: string[];
}
const SCHEMAS = schemas as unknown as Record<string, ActionSchema>;

const LABELS: Record<string, string> = {
  note: "Note for the team",
  days_before: "Remind us this many days before the submission deadline",
  user_id: "Reviewer",
  question: "Question to the buyer",
  reason: "Reason",
};

export type Payload = Record<string, unknown>;

/** Checks a payload against the action's schema, giving the same limits the server enforces. */
export function validatePayload(action: string, payload: Payload): Record<string, string> {
  const schema = SCHEMAS[action];
  if (!schema) return {};
  const errors: Record<string, string> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    const value = payload[name];
    const required = schema.required?.includes(name);
    if (prop.type === "string") {
      const text = typeof value === "string" ? value.trim() : "";
      if (required && !text) errors[name] = "Required.";
      else if (prop.minLength && text.length > 0 && text.length < prop.minLength)
        errors[name] = `At least ${prop.minLength} characters.`;
      else if (prop.maxLength && text.length > prop.maxLength) errors[name] = `At most ${prop.maxLength} characters.`;
    }
    if (prop.type === "array") {
      const list = Array.isArray(value) ? (value as number[]) : [];
      const { minimum = -Infinity, maximum = Infinity } = prop.items ?? {};
      if (prop.minItems && list.length < prop.minItems) errors[name] = `Add at least ${prop.minItems}.`;
      else if (prop.maxItems && list.length > prop.maxItems) errors[name] = `At most ${prop.maxItems}.`;
      else if (list.some((n) => !Number.isInteger(n) || n < minimum || n > maximum))
        errors[name] = `Each value must be between ${minimum} and ${maximum}.`;
    }
  }
  return errors;
}

export function PayloadForm({
  action,
  value,
  onChange,
  errors,
  members,
}: {
  action: string;
  value: Payload;
  onChange: (next: Payload) => void;
  errors: Record<string, string>;
  members: Member[];
}) {
  const schema = SCHEMAS[action];
  if (!schema) return <p className="text-sm text-muted">This action has no editable fields.</p>;
  return (
    <div className="flex flex-col gap-4">
      {Object.entries(schema.properties).map(([name, prop]) => {
        const label = LABELS[name] ?? prop.title ?? name;
        const set = (next: unknown) => onChange({ ...value, [name]: next });
        if (prop.type === "array") {
          return (
            <Field key={name} label={label} error={errors[name]} hint={`Up to ${prop.maxItems ?? 6} values, ${prop.items?.minimum ?? 1}–${prop.items?.maximum ?? 90} days.`}>
              {(props) => (
                <NumberList
                  {...props}
                  values={Array.isArray(value[name]) ? (value[name] as number[]) : []}
                  onChange={set}
                  min={prop.items?.minimum ?? 1}
                  max={prop.items?.maximum ?? 90}
                  maxItems={prop.maxItems ?? 6}
                />
              )}
            </Field>
          );
        }
        if (prop.format === "uuid") {
          return (
            <Field key={name} label={label} error={errors[name]} hint="Only current members can be assigned.">
              {(props) => (
                <Select {...props} value={String(value[name] ?? "")} onChange={(e) => set(e.target.value)}>
                  <option value="" disabled>
                    Choose a member
                  </option>
                  {members
                    .filter((member) => member.role !== "viewer")
                    .map((member) => (
                      <option key={member.user_id} value={member.user_id}>
                        {member.name ? `${member.name} (${member.login})` : member.login}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          );
        }
        const long = (prop.maxLength ?? 0) > 200;
        const text = String(value[name] ?? "");
        return (
          <Field
            key={name}
            label={label}
            error={errors[name]}
            hint={prop.maxLength ? `${text.length} / ${prop.maxLength}` : undefined}
          >
            {(props) =>
              long ? (
                <Textarea {...props} value={text} maxLength={prop.maxLength} onChange={(e) => set(e.target.value)} />
              ) : (
                <Input {...props} value={text} maxLength={prop.maxLength} onChange={(e) => set(e.target.value)} />
              )
            }
          </Field>
        );
      })}
    </div>
  );
}

function NumberList({
  values,
  onChange,
  min,
  max,
  maxItems,
  ...aria
}: {
  values: number[];
  onChange: (next: number[]) => void;
  min: number;
  max: number;
  maxItems: number;
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const n = Number(draft);
    if (Number.isInteger(n) && n >= min && n <= max && !values.includes(n) && values.length < maxItems) {
      onChange([...values, n].sort((a, b) => b - a));
      setDraft("");
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {values.map((n) => (
        <span key={n} className="inline-flex h-7 items-center gap-1 rounded-full border border-hairline bg-surface-2 pr-1 pl-3 text-sm">
          <span className="tabular font-mono">{n}</span> days
          <button
            type="button"
            className="grid size-5 place-items-center rounded-full text-faint hover:bg-surface-3 hover:text-text"
            onClick={() => onChange(values.filter((v) => v !== n))}
            aria-label={`Remove ${n} days`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {values.length < maxItems ? (
        <span className="flex items-center gap-1">
          <Input
            {...aria}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            className="w-24"
            placeholder="days"
          />
          <Button type="button" size="sm" onClick={add}>
            Add
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** Read-only view of what the action will do, in words. */
export function PayloadView({
  action,
  payload,
  members,
  deadline,
}: {
  action: string;
  payload: Payload;
  members: Member[];
  deadline: string | null | undefined;
}) {
  switch (action) {
    case "add_deadline_reminders": {
      const days = Array.isArray(payload.days_before) ? (payload.days_before as number[]) : [];
      return (
        <ul className="flex flex-wrap gap-2">
          {days.map((n) => (
            <li key={n} className="rounded-lg border border-hairline bg-surface-2 px-2.5 py-1 text-sm">
              <span className="tabular font-mono">{n}</span> days before
              {deadline ? (
                <span className="text-faint"> · {date(new Date(new Date(deadline).getTime() - n * 86_400_000).toISOString())}</span>
              ) : null}
            </li>
          ))}
        </ul>
      );
    }
    case "assign_reviewer": {
      const member = members.find((m) => m.user_id === payload.user_id);
      return (
        <p className="text-sm">
          {member ? (
            <>
              Assign <span className="font-medium">{member.name ?? member.login}</span>{" "}
              <span className="text-faint">({member.login})</span>
            </>
          ) : (
            <span className="text-soon">This person is no longer a member. Edit to choose someone else.</span>
          )}
        </p>
      );
    }
    case "draft_clarification_question": {
      const question = String(payload.question ?? "");
      return (
        <figure className="rounded-lg border-l-2 border-agent bg-agent-soft px-3 py-2">
          <blockquote className="text-sm leading-relaxed">{question}</blockquote>
          <figcaption className="mt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigator.clipboard.writeText(question).then(() => toast.success("Question copied"))}
            >
              <Copy className="size-3.5" /> Copy
            </Button>
          </figcaption>
        </figure>
      );
    }
    case "mark_no_bid":
      return <p className="text-sm">{String(payload.reason ?? "")}</p>;
    case "create_opportunity":
      return payload.note ? (
        <p className="text-sm">{String(payload.note)}</p>
      ) : (
        <p className="text-sm text-muted">Adds the notice to your pipeline, with its submission deadline.</p>
      );
    default:
      return <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify(payload, null, 2)}</pre>;
  }
}
