import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Credential, Service } from "@agent-deck/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CARD_FACE_CLASS, PLAYBOOK_CARD_COLOR, cardAccentStyle } from "@/lib/card-colors";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface PlaybookRegistrationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function PlaybookRegistrationModal({
  open,
  onOpenChange,
}: PlaybookRegistrationModalProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [triggers, setTriggers] = useState("");
  const [exec, setExec] = useState("");
  const [skill, setSkill] = useState("");
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<string[]>([]);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: credentialsResponse } = useQuery<{ success: boolean; data: Credential[] }>({
    queryKey: ["/api/credentials/vault"],
    enabled: open,
  });

  const { data: servicesResponse } = useQuery<{ success: boolean; data: Service[] }>({
    queryKey: ["/api/services"],
    enabled: open,
  });

  const credentials = credentialsResponse?.data ?? [];
  const services = servicesResponse?.data ?? [];

  const createMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/playbooks", {
        title: title.trim(),
        body,
        triggers: triggers
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        dependsOnCredentialIds: selectedCredentialIds,
        dependsOnServiceIds: selectedServiceIds,
        exec: exec.trim() || undefined,
        skill: skill.trim() || undefined,
        autoDetectDependencies: true,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbooks/vault"] });
      toast({
        title: "Playbook saved",
        description: `${title.trim()} is in your collection.`,
      });
      onOpenChange(false);
      setTitle("");
      setBody("");
      setTriggers("");
      setExec("");
      setSkill("");
      setSelectedCredentialIds([]);
      setSelectedServiceIds([]);
    },
    onError: (error: Error) => {
      toast({
        title: "Could not save playbook",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const toggleId = (ids: string[], id: string, setter: (value: string[]) => void) => {
    setter(ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]);
  };

  const canSave = title.trim().length > 0 && body.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto border-border bg-[#161612] text-[#E8F6F4]">
        <DialogHeader>
          <DialogTitle>Register Playbook</DialogTitle>
          <DialogDescription className="text-[#A8C4C0]">
            Prefer{" "}
            <span className="font-mono text-xs">register_playbook</span> /{" "}
            <span className="font-mono text-xs">update_playbook</span> from your AI agent. This
            form also auto-detects API key and MCP dependencies from the content on save.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="playbook-title">Title</Label>
            <Input
              id="playbook-title"
              placeholder="Hiring inbox, Ashby API guide…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="border-white/15 bg-[#0F0F0C] text-[#E8F6F4]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="playbook-triggers">Triggers (comma-separated, max 16)</Label>
            <Input
              id="playbook-triggers"
              placeholder="check inbox, review applicants"
              value={triggers}
              onChange={(e) => setTriggers(e.target.value)}
              className="border-white/15 bg-[#0F0F0C] text-[#E8F6F4]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="playbook-body">Instructions (markdown)</Label>
            <Textarea
              id="playbook-body"
              rows={8}
              placeholder="# Steps&#10;1. …&#10;2. …"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="border-white/15 bg-[#0F0F0C] text-[#E8F6F4] font-mono text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Extra API key deps (optional)</Label>
              <p className="text-xs text-gray-500">Merged with auto-detected refs from content.</p>
              <div className="max-h-28 overflow-y-auto rounded border border-white/10 p-2 space-y-1">
                {credentials.length === 0 ? (
                  <p className="text-xs text-gray-500">No API keys registered yet.</p>
                ) : (
                  credentials.map((credential) => (
                    <label key={credential.id} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedCredentialIds.includes(credential.id)}
                        onChange={() =>
                          toggleId(selectedCredentialIds, credential.id, setSelectedCredentialIds)
                        }
                      />
                      {credential.label}
                    </label>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Extra MCP deps (optional)</Label>
              <p className="text-xs text-gray-500">Merged with auto-detected refs from content.</p>
              <div className="max-h-28 overflow-y-auto rounded border border-white/10 p-2 space-y-1">
                {services.length === 0 ? (
                  <p className="text-xs text-gray-500">No MCP services registered yet.</p>
                ) : (
                  services.map((service) => (
                    <label key={service.id} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedServiceIds.includes(service.id)}
                        onChange={() =>
                          toggleId(selectedServiceIds, service.id, setSelectedServiceIds)
                        }
                      />
                      {service.name}
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="playbook-exec">Suggested exec (optional)</Label>
            <Input
              id="playbook-exec"
              placeholder="agent-deck exec --connections … -- uv run …"
              value={exec}
              onChange={(e) => setExec(e.target.value)}
              className="border-white/15 bg-[#0F0F0C] text-[#E8F6F4] font-mono text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="playbook-skill">Skill path hint (optional)</Label>
            <Input
              id="playbook-skill"
              placeholder=".cursor/skills/…/SKILL.md"
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
              className="border-white/15 bg-[#0F0F0C] text-[#E8F6F4] font-mono text-xs"
            />
          </div>

          <Button
            variant="ghost"
            className={`w-full border-2 hover:opacity-90 ${CARD_FACE_CLASS}`}
            style={cardAccentStyle(PLAYBOOK_CARD_COLOR)}
            onClick={() => createMutation.mutate()}
            disabled={!canSave || createMutation.isPending}
          >
            Save to collection
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
