import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { annotatorAPI } from "../services/api";
import type { InstructionAsset, InstructionBundle } from "../types";

type InstructionPanelProps = {
  projectId?: string;
  bundle?: InstructionBundle | null;
  fallbackText?: string;
  compact?: boolean;
  autoOpen?: boolean;
  buttonLabel?: string;
};

function assetKindLabel(asset: InstructionAsset) {
  const labels: Record<string, string> = {
    instruction: "Инструкция",
    link: "Ссылка",
    embedded: "Блок",
    good_example: "Хороший пример",
    bad_example: "Плохой пример",
    annotated_example: "Размеченный пример",
  };
  return labels[asset.asset_type] || asset.asset_type;
}

function isHtmlInstruction(asset: InstructionAsset) {
  const value = `${asset.file_name || ""} ${asset.file_uri || ""}`.toLowerCase();
  return value.includes(".html") || value.includes(".htm");
}

function AssetItem({ asset, projectId }: { asset: InstructionAsset; projectId?: string }) {
  const labelData = Object.keys(asset.label_data || {}).length ? JSON.stringify(asset.label_data, null, 2) : "";
  return (
    <div className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium text-gray-900 dark:text-white">{asset.title || asset.file_name || asset.url || assetKindLabel(asset)}</div>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">{assetKindLabel(asset)}</span>
      </div>
      {asset.body ? <div className="mt-2 whitespace-pre-wrap text-gray-700 dark:text-gray-300">{asset.body}</div> : null}
      {asset.url ? (
        <a className="mt-2 inline-block text-blue-600 hover:underline dark:text-blue-400" href={asset.url} target="_blank" rel="noreferrer">
          Открыть ссылку
        </a>
      ) : null}
      {asset.file_uri && isHtmlInstruction(asset) && projectId ? (
        <Link className="mt-2 inline-block text-blue-600 hover:underline dark:text-blue-400" to={`/projects/${projectId}/instructions`}>
          Open instruction page
        </Link>
      ) : asset.file_uri ? (
        <a className="mt-2 inline-block text-blue-600 hover:underline dark:text-blue-400" href={asset.file_uri} target="_blank" rel="noreferrer">
          {asset.file_name || "Открыть файл"}
        </a>
      ) : null}
      {labelData ? <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-950 p-2 text-xs text-green-200">{labelData}</pre> : null}
    </div>
  );
}

export function InstructionPanel({ projectId, bundle, fallbackText = "", compact = false, autoOpen = false, buttonLabel }: InstructionPanelProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const assets = bundle?.assets ?? [];
  const instructions = bundle?.instructions ?? fallbackText;
  const acknowledged = Boolean(bundle?.acknowledgement?.acknowledged);
  const hasContent = Boolean(bundle || instructions || assets.length);

  const groupedAssets = useMemo(() => {
    const good = assets.filter((asset) => asset.asset_type === "good_example" || asset.asset_type === "annotated_example");
    const bad = assets.filter((asset) => asset.asset_type === "bad_example");
    const instructionAssets = assets.filter((asset) => !["good_example", "bad_example", "annotated_example"].includes(asset.asset_type));
    return { instructionAssets, good, bad };
  }, [assets]);

  const ackMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("projectId missing");
      return annotatorAPI.acknowledgeInstructions(projectId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["annotator-project-detail", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-instructions", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-assignment"] });
      await queryClient.invalidateQueries({ queryKey: ["interval-chunk-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["interval-validation-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["bbox-validation-queue"] });
    },
  });

  useEffect(() => {
    if (autoOpen && hasContent && !acknowledged) {
      setOpen(true);
    }
  }, [autoOpen, acknowledged, hasContent, bundle?.instructions_version]);

  return (
    <>
      <button type="button" className={compact ? "btn-secondary" : "btn-primary"} onClick={() => setOpen(true)} disabled={!hasContent}>
        {buttonLabel || "Инструкция"}
        {acknowledged ? "" : " *"}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/70 p-4">
          <section className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-800 dark:bg-gray-950">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-5 py-4 dark:border-gray-800">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Инструкция и примеры</h2>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Версия {bundle?.instructions_version ?? 0}
                  {bundle?.instructions_updated_at ? ` · ${new Date(bundle.instructions_updated_at).toLocaleString()}` : ""}
                  {acknowledged ? " · прочитано" : ""}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {projectId && !acknowledged ? (
                  <button type="button" className="btn-primary" onClick={() => ackMutation.mutate()} disabled={ackMutation.isPending}>
                    {ackMutation.isPending ? "Сохраняем..." : "Подтвердить чтение"}
                  </button>
                ) : null}
                <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                  Закрыть
                </button>
              </div>
            </div>

            <div className="flex-1 space-y-4 overflow-auto px-5 py-4">
              <div className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
                {instructions || "Инструкция пока не добавлена."}
              </div>
              {groupedAssets.instructionAssets.length ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">Материалы</div>
                  {groupedAssets.instructionAssets.map((asset) => <AssetItem key={asset.id} asset={asset} projectId={projectId} />)}
                </div>
              ) : null}
              {groupedAssets.good.length ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Хорошая разметка</div>
                  {groupedAssets.good.map((asset) => <AssetItem key={asset.id} asset={asset} projectId={projectId} />)}
                </div>
              ) : null}
              {groupedAssets.bad.length ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-red-700 dark:text-red-300">Плохая разметка</div>
                  {groupedAssets.bad.map((asset) => <AssetItem key={asset.id} asset={asset} projectId={projectId} />)}
                </div>
              ) : null}
              {ackMutation.isError ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">Не удалось сохранить подтверждение.</div> : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

export function InstructionGate({ projectId, bundle, fallbackText }: InstructionPanelProps) {
  if (!bundle || bundle.acknowledgement.acknowledged) {
    return null;
  }
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <div className="font-semibold">Перед стартом нужно прочитать инструкцию</div>
      <div className="mt-2 text-sm">Откройте инструкцию и подтвердите чтение текущей версии. После обновления инструкции подтверждение потребуется снова.</div>
      <div className="mt-3">
        <InstructionPanel projectId={projectId} bundle={bundle} fallbackText={fallbackText} compact />
      </div>
    </div>
  );
}
