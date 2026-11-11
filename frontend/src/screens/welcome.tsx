import { Link, useNavigate } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useState, type FormEvent } from "react";

import { fieldErrors } from "@/api/errors";
import { useCreateOrg } from "@/api/hooks";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";

const splitList = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function Welcome() {
  const navigate = useNavigate();
  const create = useCreateOrg();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const errors = fieldErrors(create.error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const org = await create.mutateAsync({
      name: name.trim(),
      profile: { description: description.trim(), capabilities: splitList(capabilities), regions: ["IRL"] },
    });
    await navigate({ to: "/o/$orgId/searches", params: { orgId: org.id } });
  }

  return (
    <main className="app-backdrop grain grid min-h-dvh place-items-center px-4 py-10">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        className="glass flex w-full max-w-lg flex-col gap-5 rounded-2xl p-7"
      >
        <Link to="/app" aria-label="Tenderline">
          <Logo />
        </Link>
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.01em]">Set up your company</h1>
          <p className="mt-1 text-sm text-muted">
            The agent reads this profile when it judges whether a tender fits. You can change it later in Settings.
          </p>
        </div>
        <Field label="Company name" error={errors.name}>
          {(props) => (
            <Input {...props} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={200} />
          )}
        </Field>
        <Field label="What you do" hint="Two or three sentences, in plain words." error={errors.description}>
          {(props) => (
            <Textarea {...props} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          )}
        </Field>
        <Field label="Capabilities" hint="Comma separated, e.g. cloud hosting, cyber security, managed IT">
          {(props) => <Input {...props} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} />}
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" pending={create.isPending}>
            Create and add a saved search
          </Button>
        </div>
      </motion.form>
    </main>
  );
}
