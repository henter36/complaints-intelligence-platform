"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  Tags,
  Plus,
  Edit,
  FolderTree,
  Palette,
  Folder,
  FolderOpen,
  Hash,
  FileText,
  CheckCircle2,
  X,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { formatNumber } from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";
import { normalizeClassificationKeyword } from "@/lib/classifications/classification-keyword-normalizer";

// ---------- Types ----------
type NodeType = "CATEGORY" | "CLASSIFICATION";

interface Classification {
  id: string;
  nodeType: NodeType;
  name: string;
  description?: string | null;
  color?: string;
  keywords?: unknown;
  parentId?: string | null;
  children?: Classification[];
}

interface DistributionItem {
  name: string;
  count: number;
}

interface DashboardData {
  distributions?: {
    byClassification?: DistributionItem[];
  };
}

function isCategoryNode(node: Classification): boolean {
  return node.nodeType === "CATEGORY" || (!node.nodeType && !node.parentId);
}

function isClassificationNode(node: Classification): boolean {
  return node.nodeType === "CLASSIFICATION" || (!node.nodeType && Boolean(node.parentId));
}

function readApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

export type ClassificationDialogMode =
  | "EDIT_CATEGORY"
  | "EDIT_CLASSIFICATION"
  | "CREATE_CATEGORY"
  | "CREATE_CLASSIFICATION";

export type ClassificationDialogPresentation = {
  mode: ClassificationDialogMode;
  title: string;
  description: string;
  icon: "edit" | "plus";
};

export function getClassificationDialogPresentation(
  editing: Classification | null,
  creatingCategory: boolean
): ClassificationDialogPresentation {
  if (editing) {
    if (isCategoryNode(editing)) {
      return {
        mode: "EDIT_CATEGORY",
        title: "تعديل الفئة الرئيسية",
        description: "عدّل اسم ووصف الفئة الرئيسية فقط",
        icon: "edit",
      };
    }
    if (isClassificationNode(editing)) {
      return {
        mode: "EDIT_CLASSIFICATION",
        title: "تعديل التصنيف",
        description:
          "عدّل بيانات التصنيف والكلمات المفتاحية. الحفظ يتم بزر حفظ التغييرات فقط.",
        icon: "edit",
      };
    }
    return {
      mode: "EDIT_CLASSIFICATION",
      title: "تعديل التصنيف",
      description: "نوع عقدة التصنيف غير مدعوم",
      icon: "edit",
    };
  }
  if (creatingCategory) {
    return {
      mode: "CREATE_CATEGORY",
      title: "إضافة فئة رئيسية",
      description: "أنشئ فئة رئيسية جديدة بدون كلمات مفتاحية",
      icon: "plus",
    };
  }
  return {
    mode: "CREATE_CLASSIFICATION",
    title: "إضافة تصنيف فرعي",
    description:
      "أدخل بيانات التصنيف الفرعي والكلمات المفتاحية (مسودة حتى الحفظ)",
    icon: "plus",
  };
}

export type ClassificationMutationRequest = {
  url: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
};

export type ClassificationMutationState = {
  editing: Classification | null;
  creatingCategory: boolean;
  formName: string;
  formDescription: string;
  formColor: string;
  formKeywords: string[];
  formParentId: string;
};

export function buildClassificationMutationRequest(
  state: ClassificationMutationState
): ClassificationMutationRequest {
  const {
    editing,
    creatingCategory,
    formName,
    formDescription,
    formColor,
    formKeywords,
    formParentId,
  } = state;
  const name = formName.trim();
  const description = formDescription.trim() || null;

  if (editing) {
    switch (editing.nodeType) {
      case "CATEGORY":
        return {
          url: `/api/categories/${editing.id}`,
          method: "PATCH",
          body: { name, description },
        };
      case "CLASSIFICATION":
        return {
          url: `/api/classifications/${editing.id}`,
          method: "PATCH",
          body: {
            name,
            description,
            color: formColor,
            keywords: formKeywords,
            categoryId: formParentId || editing.parentId,
          },
        };
      default:
        throw new Error("نوع عقدة التصنيف غير مدعوم");
    }
  }

  if (creatingCategory) {
    return {
      url: "/api/categories",
      method: "POST",
      body: { name, description },
    };
  }

  if (!formParentId) {
    throw new Error("اختر فئة أب للتصنيف الفرعي");
  }
  return {
    url: "/api/classifications",
    method: "POST",
    body: {
      categoryId: formParentId,
      name,
      description,
      color: formColor,
      keywords: formKeywords,
    },
  };
}

export function normalizeClassificationTree(
  classData: Classification[]
): Classification[] {
  return classData.map((node) => ({
    ...node,
    nodeType: node.nodeType ?? ("CATEGORY" as NodeType),
    children: (node.children ?? []).map((child) => ({
      ...child,
      nodeType: child.nodeType ?? ("CLASSIFICATION" as NodeType),
    })),
  }));
}

export function buildDistributionMap(dashData: DashboardData): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of dashData.distributions?.byClassification ?? []) {
    map.set(item.name, item.count);
  }
  return map;
}

async function loadClassificationTree(signal?: AbortSignal): Promise<Classification[]> {
  const classRes = await fetch("/api/classifications", { signal });
  if (!classRes.ok) throw new Error("فشل تحميل التصنيفات");
  const classData: Classification[] = await classRes.json();
  return normalizeClassificationTree(classData);
}

async function loadDashboardDistribution(
  signal?: AbortSignal
): Promise<Map<string, number> | null> {
  const dashRes = await fetch("/api/dashboard", { signal });
  if (!dashRes.ok) return null;
  const dashData: DashboardData = await dashRes.json();
  return buildDistributionMap(dashData);
}

export async function loadClassificationManagerData(signal?: AbortSignal): Promise<{
  tree: Classification[];
  distribution: Map<string, number> | null;
}> {
  const [tree, distribution] = await Promise.all([
    loadClassificationTree(signal),
    loadDashboardDistribution(signal),
  ]);
  return { tree, distribution };
}

function mergeKeywordsIntoDraft(previous: string[], values: string[]): string[] {
  const seen = new Set(previous.map(normalizeClassificationKeyword).filter(Boolean));
  const next = [...previous];
  for (const value of values) {
    const normalized = normalizeClassificationKeyword(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(value);
  }
  return next;
}


// ---------- Preset colors (government-grade palette) ----------
const PRESET_COLORS = [
  { name: "زمردي", value: "#10b981" },
  { name: "أخضر داكن", value: "#059669" },
  { name: "نعناعي", value: "#14b8a6" },
  { name: "سماوي", value: "#0ea5e9" },
  { name: "أزرق", value: "#3b82f6" },
  { name: "بنفسجي", value: "#8b5cf6" },
  { name: "وردي", value: "#ec4899" },
  { name: "أحمر", value: "#ef4444" },
  { name: "برتقالي", value: "#f97316" },
  { name: "كهرماني", value: "#f59e0b" },
  { name: "أصفر", value: "#eab308" },
  { name: "رمادي", value: "#64748b" },
];

// ---------- Helpers ----------
function parseKeywords(raw?: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string" && Boolean(value));
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

type ImportedDetailItem = {
  normalizedValue: string;
  displayValue: string;
  occurrences: number;
  linkedKeywordsCount: number;
  alreadyLinkedToCurrentClassification: boolean;
  linkedToOtherClassification: boolean;
  linkedClassificationName?: string | null;
};

const IMPORTED_VALUES_LOAD_ERROR_MESSAGE = "تعذر تحميل القيم المستوردة.";

export function ImportedDetailPicker({
  classificationId,
  existingKeywords,
  onSelect,
}: Readonly<{
  classificationId: string;
  existingKeywords: string[];
  onSelect: (values: string[]) => void;
}>) {
  const { toast } = useToast();
  const [items, setItems] = useState<ImportedDetailItem[]>([]);
  /** normalizedValue → displayValue — preserved across pagination/search */
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState("");
  const [linkStatus, setLinkStatus] = useState("ALL");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [availableTotal, setAvailableTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const valuesRequestIdRef = useRef(0);
  const valuesAbortControllerRef = useRef<AbortController | null>(null);
  const pageSize = 20;

  const existingNormalized = useMemo(() => {
    const set = new Set<string>();
    for (const keyword of existingKeywords) {
      const normalized = normalizeClassificationKeyword(keyword);
      if (normalized) set.add(normalized);
    }
    return set;
  }, [existingKeywords]);

  const loadValues = useCallback(async () => {
    valuesAbortControllerRef.current?.abort();
    const controller = new AbortController();
    valuesAbortControllerRef.current = controller;
    const requestId = ++valuesRequestIdRef.current;
    const isLatestRequest = () => valuesRequestIdRef.current === requestId;

    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({
        classificationId,
        linkStatus,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (search.trim()) params.set("search", search.trim());
      const response = await fetch(`/api/classifications/imported-detail-values?${params}`, {
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(IMPORTED_VALUES_LOAD_ERROR_MESSAGE);
      if (!isLatestRequest()) return;
      setItems(payload.items);
      setTotal(payload.total);
      setAvailableTotal(payload.availableTotal ?? payload.total);
      setHasLoaded(true);
    } catch (error) {
      if (isAbortError(error) || !isLatestRequest()) return;
      setLoadError(IMPORTED_VALUES_LOAD_ERROR_MESSAGE);
      setHasLoaded(true);
    } finally {
      if (isLatestRequest()) {
        setLoading(false);
        valuesAbortControllerRef.current = null;
      }
    }
  }, [classificationId, linkStatus, page, search]);

  useEffect(() => {
    void Promise.resolve().then(() => loadValues());
    return () => {
      valuesAbortControllerRef.current?.abort();
      valuesRequestIdRef.current += 1;
    };
  }, [loadValues]);

  const isDisabled = (item: ImportedDetailItem) =>
    item.alreadyLinkedToCurrentClassification
    || item.linkedToOtherClassification
    || existingNormalized.has(item.normalizedValue);

  const selectableItems = items.filter((item) => !isDisabled(item));
  const allSelected =
    selectableItems.length > 0
    && selectableItems.every((item) => selected.has(item.normalizedValue));

  const toggleValue = (item: ImportedDetailItem) => {
    if (isDisabled(item)) return;
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(item.normalizedValue)) next.delete(item.normalizedValue);
      else next.set(item.normalizedValue, item.displayValue);
      return next;
    });
  };

  const addSelectedToDraft = () => {
    if (selected.size === 0) return;
    const values = [...selected.values()].filter((value) => {
      const n = normalizeClassificationKeyword(value);
      return n && !existingNormalized.has(n);
    });
    if (values.length === 0) {
      toast({
        title: "لا قيم جديدة",
        description: "القيم المحددة موجودة بالفعل في المسودة.",
      });
      return;
    }
    onSelect(values);
    setSelected(new Map());
    toast({
      title: "أُضيفت إلى المسودة",
      description: `أُضيفت ${formatNumber(values.length)} قيمة. لن تحفظ حتى الضغط على حفظ التغييرات.`,
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
        <Input
          value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          placeholder="ابحث في قيم تفصيل"
          aria-label="البحث في قيم تفصيل"
        />
        <Select value={linkStatus} onValueChange={(value) => { setLinkStatus(value); setPage(1); }}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">جميع القيم</SelectItem>
            <SelectItem value="UNLINKED">غير مرتبطة</SelectItem>
            <SelectItem value="CURRENT">مرتبطة بهذا التصنيف</SelectItem>
            <SelectItem value="OTHER">مرتبطة بتصنيفات أخرى</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          إجمالي القيم: {formatNumber(total)}
          {selected.size > 0 ? ` · تم اختيار ${formatNumber(selected.size)} قيمة` : ""}
        </span>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={allSelected}
            onCheckedChange={() => {
              setSelected((current) => {
                const next = new Map(current);
                for (const item of selectableItems) {
                  if (allSelected) next.delete(item.normalizedValue);
                  else next.set(item.normalizedValue, item.displayValue);
                }
                return next;
              });
            }}
          />
          اختيار الكل في الصفحة
        </label>
      </div>
      {loading && <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
      {!loading && loadError && (
        <div className="space-y-3 rounded-md border border-destructive/30 p-4" role="alert">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadValues()}>
            <RefreshCw className="h-4 w-4" />
            إعادة المحاولة
          </Button>
        </div>
      )}
      {hasLoaded && !loading && !loadError && items.length === 0 && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {availableTotal === 0 && !search.trim() && linkStatus === "ALL"
            ? "لا توجد بيانات مستوردة من حقل «تفصيل»."
            : "لا توجد قيم مطابقة للبحث أو التصفية الحالية."}
        </p>
      )}
      {!loading && items.length > 0 && (
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
          {items.map((item) => {
            const disabled = isDisabled(item);
            return (
              <label key={item.normalizedValue} className="flex items-center gap-3 rounded-md p-2 hover:bg-muted/50">
                <Checkbox
                  checked={selected.has(item.normalizedValue)}
                  disabled={disabled}
                  onCheckedChange={() => toggleValue(item)}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{item.displayValue}</span>
                <span className="text-xs text-muted-foreground">{formatNumber(item.occurrences)} ظهور</span>
                {item.alreadyLinkedToCurrentClassification && <Badge variant="secondary">مضافة مسبقًا</Badge>}
                {!item.alreadyLinkedToCurrentClassification
                  && item.linkedToOtherClassification && (
                  <Badge variant="destructive">
                    {item.linkedClassificationName
                      ? `مرتبطة: ${item.linkedClassificationName}`
                      : "مرتبطة بتصنيف آخر"}
                  </Badge>
                )}
                {existingNormalized.has(item.normalizedValue)
                  && !item.alreadyLinkedToCurrentClassification
                  && !item.linkedToOtherClassification && (
                  <Badge variant="outline">مضافة إلى المسودة</Badge>
                )}
                {item.linkedKeywordsCount === 0
                  && !item.linkedToOtherClassification
                  && !item.alreadyLinkedToCurrentClassification
                  && !existingNormalized.has(item.normalizedValue) && (
                  <Badge variant="outline">غير مرتبطة</Badge>
                )}
              </label>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          <Button type="button" variant="outline" size="sm" disabled={page === 1 || loading} onClick={() => setPage((value) => value - 1)}>السابق</Button>
          <Button type="button" variant="outline" size="sm" disabled={page * pageSize >= total || loading} onClick={() => setPage((value) => value + 1)}>التالي</Button>
        </div>
        <Button type="button" size="sm" disabled={selected.size === 0} onClick={addSelectedToDraft}>
          إضافة المحدد إلى المسودة
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        لن تحفظ الكلمات حتى الضغط على حفظ التغييرات.
      </p>
    </div>
  );
}

// Flatten tree for selector + merge list
function flatten(list: Classification[]): Classification[] {
  const out: Classification[] = [];
  const walk = (items: Classification[]) => {
    for (const item of items) {
      out.push(item);
      if (item.children?.length) walk(item.children);
    }
  };
  walk(list);
  return out;
}

// Get color with contrast for text overlay
function readableText(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length < 6) return "#ffffff";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0f172a" : "#ffffff";
}

// ---------- Keyword Tag Input ----------
interface KeywordInputProps {
  keywords: string[];
  onChange: (next: string[]) => void;
}

function KeywordInput({ keywords, onChange }: KeywordInputProps) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (keywords.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...keywords, v]);
    setDraft("");
  };
  const remove = (kw: string) => onChange(keywords.filter((k) => k !== kw));
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="اكتب كلمة مفتاحية ثم اضغط Enter"
        />
        <Button type="button" variant="secondary" onClick={add} size="sm">
          <Plus className="h-4 w-4" />
          إضافة
        </Button>
      </div>
      {keywords.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 min-h-[2rem] p-2 rounded-md border bg-muted/30">
          {keywords.map((kw) => (
            <Badge
              key={kw}
              variant="secondary"
              className="gap-1 pr-1 pl-2 py-1 text-xs"
            >
              <Hash className="h-3 w-3 opacity-60" />
              {kw}
              <button
                type="button"
                onClick={() => remove(kw)}
                className="rounded-full hover:bg-destructive/20 p-0.5 transition-colors"
                aria-label={`حذف ${kw}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          لا توجد كلمات مفتاحية. أضف كلمات لتسهيل التصنيف الآلي.
        </p>
      )}
    </div>
  );
}

// ---------- Color Picker ----------
interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-6 gap-2">
        {PRESET_COLORS.map((c) => {
          const active = value.toLowerCase() === c.value.toLowerCase();
          return (
            <TooltipProvider key={c.value}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onChange(c.value)}
                    className={`relative h-9 w-9 rounded-md border-2 transition-all hover:scale-110 ${
                      active
                        ? "border-foreground ring-2 ring-ring/40"
                        : "border-transparent"
                    }`}
                    style={{ backgroundColor: c.value }}
                    aria-label={c.name}
                  >
                    {active && (
                      <CheckCircle2
                        className="absolute inset-0 m-auto h-4 w-4"
                        style={{ color: readableText(c.value) }}
                      />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{c.name}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Label htmlFor="custom-color" className="text-xs text-muted-foreground">
          لون مخصص:
        </Label>
        <input
          id="custom-color"
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-12 cursor-pointer rounded border bg-transparent p-0.5"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-28 font-mono text-xs"
        />
      </div>
    </div>
  );
}

// ---------- Classification Card ----------
interface ClassificationCardProps {
  classification: Classification;
  complaintCount: number;
  depth: number;
  onEdit: (c: Classification) => void;
  onAddChild: (parent: Classification) => void;
}

function ClassificationCard({
  classification,
  complaintCount,
  depth,
  onEdit,
  onAddChild,
}: ClassificationCardProps) {
  const hasChildren =
    classification.children && classification.children.length > 0;
  const [open, setOpen] = useState(true);
  const keywords = parseKeywords(classification.keywords);
  const isCategory = isCategoryNode(classification);
  const accentColor = classification.color || "#64748b";

  return (
    <div className="space-y-2" style={{ marginInlineStart: `${depth * 1.5}rem` }}>
      <Card className="card-hover overflow-hidden transition-all border-border">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div
              className="h-12 w-1.5 rounded-full shrink-0 self-stretch"
              style={{ backgroundColor: isCategory ? "#94a3b8" : accentColor }}
              aria-hidden
            />

            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  {hasChildren || isCategory ? (
                    <button
                      type="button"
                      onClick={() => setOpen((o) => !o)}
                      className="rounded p-1 hover:bg-accent transition-colors"
                      aria-label="تبديل العرض"
                    >
                      {open ? (
                        <FolderOpen className="h-4 w-4 text-primary" />
                      ) : (
                        <Folder className="h-4 w-4 text-primary" />
                      )}
                    </button>
                  ) : (
                    <Tags
                      className="h-4 w-4 text-muted-foreground shrink-0"
                      style={{ color: accentColor }}
                    />
                  )}
                  <h4 className="font-semibold text-base truncate">
                    {classification.name}
                  </h4>
                  <Badge variant="outline" className="text-[10px]">
                    {isCategory ? "فئة" : "تصنيف"}
                  </Badge>
                  {hasChildren && (
                    <Badge variant="outline" className="text-[10px]">
                      {formatNumber(classification.children!.length)} تصنيف فرعي
                    </Badge>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          data-testid={`edit-node-${classification.id}`}
                          aria-label={`تعديل ${classification.name}`}
                          onClick={() => onEdit(classification)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>تعديل</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {isCategory && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={() => onAddChild(classification)}
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>إضافة تصنيف فرعي</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </div>

              {classification.description && (
                <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                  {classification.description}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <FileText className="h-3.5 w-3.5" />
                  {formatNumber(complaintCount)} شكوى
                </span>
                {isClassificationNode(classification) && (
                  <span className="flex items-center gap-1">
                    <Hash className="h-3.5 w-3.5" />
                    {formatNumber(keywords.length)} كلمة مفتاحية
                  </span>
                )}
              </div>

              {isClassificationNode(classification) && keywords.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {keywords.slice(0, 8).map((kw) => (
                    <Badge key={kw} variant="secondary" className="text-[10px]">
                      {kw}
                    </Badge>
                  ))}
                  {keywords.length > 8 && (
                    <Badge variant="outline" className="text-[10px]">
                      +{formatNumber(keywords.length - 8)}
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {hasChildren && (
        <Collapsible open={open}>
          <CollapsibleContent>
            <div
              className="relative space-y-2 pt-1"
              style={{ marginInlineStart: "1.25rem" }}
            >
              <div
                className="absolute top-0 bottom-2 w-px bg-border"
                style={{ insetInlineStart: "-0.5rem" }}
                aria-hidden
              />
              {classification.children!.map((child) => (
                <ClassificationCard
                  key={child.id}
                  classification={{ ...child, nodeType: child.nodeType ?? "CLASSIFICATION" }}
                  complaintCount={0}
                  depth={0}
                  onEdit={onEdit}
                  onAddChild={onAddChild}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

// ---------- Main Component ----------
export function ClassificationsManager() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [classifications, setClassifications] = useState<Classification[]>([]);
  const [distributionMap, setDistributionMap] = useState<Map<string, number>>(
    new Map()
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Classification | null>(null);
  const [formParentId, setFormParentId] = useState<string>("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formColor, setFormColor] = useState(PRESET_COLORS[0].value);
  const [formKeywords, setFormKeywords] = useState<string[]>([]);
  const fetchRequestRef = useRef(0);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    const requestId = fetchRequestRef.current + 1;
    fetchRequestRef.current = requestId;
    const isLatest = () => !signal?.aborted && fetchRequestRef.current === requestId;
    setLoading(true);
    let aborted = false;
    try {
      const { tree, distribution } = await loadClassificationManagerData(signal);
      if (!isLatest()) return;
      setClassifications(tree);
      if (distribution) {
        setDistributionMap(distribution);
      }
    } catch (err) {
      aborted = isAbortError(err);
      if (aborted) return;
      const msg = err instanceof Error ? err.message : "خطأ غير متوقع";
      toast({
        title: "خطأ",
        description: msg,
        variant: "destructive",
      });
    } finally {
      if (!aborted && isLatest()) {
        setLoading(false);
      }
    }
  }, [toast]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        void fetchData(controller.signal);
      }
    });
    return () => {
      controller.abort();
    };
  }, [fetchData]);

  const flatList = useMemo(() => flatten(classifications), [classifications]);
  const categoryOptions = useMemo(
    () => classifications.filter((node) => isCategoryNode(node)),
    [classifications]
  );

  const complaintCountFor = useCallback(
    (c: Classification): number => {
      const direct = distributionMap.get(c.name) ?? 0;
      let total = direct;
      if (c.children?.length) {
        for (const child of c.children) {
          total += distributionMap.get(child.name) ?? 0;
        }
      }
      return total;
    },
    [distributionMap]
  );

  const resetForm = () => {
    setFormName("");
    setFormDescription("");
    setFormColor(PRESET_COLORS[0].value);
    setFormKeywords([]);
    setFormParentId("");
    setEditing(null);
    setCreatingCategory(false);
  };

  const openAddCategoryDialog = () => {
    resetForm();
    setCreatingCategory(true);
    setDialogOpen(true);
  };

  const openAddClassificationDialog = (parent?: Classification) => {
    resetForm();
    setCreatingCategory(false);
    setFormParentId(parent?.id ?? "");
    setDialogOpen(true);
  };

  const openEditDialog = (c: Classification) => {
    setEditing(c);
    setCreatingCategory(false);
    setFormName(c.name);
    setFormDescription(c.description ?? "");
    setFormColor(c.color || PRESET_COLORS[0].value);
    setFormKeywords(parseKeywords(c.keywords));
    setFormParentId(c.parentId ?? "");
    setDialogOpen(true);
  };

  const editingIsCategory = editing ? isCategoryNode(editing) : creatingCategory;
  const dialogPresentation = getClassificationDialogPresentation(editing, creatingCategory);

  const handleSubmit = async () => {
    if (!formName.trim()) {
      toast({
        title: "تحقق من البيانات",
        description: "الاسم مطلوب",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const mutation = buildClassificationMutationRequest({
        editing,
        creatingCategory,
        formName,
        formDescription,
        formColor,
        formKeywords,
        formParentId,
      });
      const res = await fetch(mutation.url, {
        method: mutation.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mutation.body),
      });

      const errBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(readApiErrorMessage(errBody, "فشل الحفظ"));
      }

      const savedName = formName.trim();
      const wasEditing = Boolean(editing);
      setDialogOpen(false);
      resetForm();
      await fetchData();
      toast({
        title: wasEditing ? "تم التحديث" : "تمت الإضافة",
        description: wasEditing
          ? `تم تحديث "${savedName}" بنجاح`
          : `تمت إضافة "${savedName}" بنجاح`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "خطأ غير متوقع";
      toast({
        title: "خطأ في الحفظ",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const totalClassifications = flatList.length;
  const totalKeywords = flatList.reduce(
    (sum, c) => sum + (isClassificationNode(c) ? parseKeywords(c.keywords).length : 0),
    0
  );
  const totalComplaints = Array.from(distributionMap.values()).reduce(
    (s, n) => s + n,
    0
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="إدارة التصنيفات"
        description="إدارة شجرة الفئات والتصنيفات والكلمات المفتاحية"
        icon={<FolderTree className="h-6 w-6" />}
        actions={
          <>
            <Button variant="outline" onClick={() => void fetchData()} size="sm">
              <RefreshCw className="h-4 w-4" />
              تحديث
            </Button>
            <Button variant="outline" onClick={openAddCategoryDialog} size="sm">
              <Plus className="h-4 w-4" />
              فئة رئيسية
            </Button>
            <Button onClick={() => openAddClassificationDialog()} size="sm">
              <Plus className="h-4 w-4" />
              تصنيف جديد
            </Button>
          </>
        }
      />

      {/* Stats summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))
        ) : (
          <>
            <Card className="card-hover">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FolderTree className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      إجمالي التصنيفات
                    </p>
                    <p className="text-2xl font-bold tabular-nums">
                      {formatNumber(totalClassifications)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="card-hover">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                    <Tags className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      الكلمات المفتاحية
                    </p>
                    <p className="text-2xl font-bold tabular-nums">
                      {formatNumber(totalKeywords)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="card-hover">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                    <FileText className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      الشكاوى المصنفة
                    </p>
                    <p className="text-2xl font-bold tabular-nums">
                      {formatNumber(totalComplaints)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="card-hover">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                    <Palette className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      التصنيفات الرئيسية
                    </p>
                    <p className="text-2xl font-bold tabular-nums">
                      {formatNumber(classifications.length)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Tree */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FolderTree className="h-4 w-4 text-primary" />
            شجرة التصنيفات
          </CardTitle>
          <CardDescription className="text-xs">
            اضغط على المجلد لطي/توسيع التصنيفات الفرعية
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full rounded-xl" />
              ))}
            </div>
          ) : classifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
                <FolderTree className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="font-semibold text-lg">لا توجد تصنيفات</h3>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                ابدأ بإضافة أول فئة رئيسية للنظام
              </p>
              <Button onClick={openAddCategoryDialog}>
                <Plus className="h-4 w-4" />
                إضافة فئة رئيسية
              </Button>
            </div>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pl-1">
              {classifications.map((c) => (
                <ClassificationCard
                  key={c.id}
                  classification={c}
                  complaintCount={complaintCountFor(c)}
                  depth={0}
                  onEdit={openEditDialog}
                  onAddChild={openAddClassificationDialog}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) resetForm();
        }}
      >
        <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {dialogPresentation.icon === "edit" ? (
                <Edit className="h-5 w-5 text-primary" />
              ) : (
                <Plus className="h-5 w-5 text-primary" />
              )}
              {dialogPresentation.title}
            </DialogTitle>
            <DialogDescription>
              {dialogPresentation.description}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="cls-name">
                الاسم <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cls-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={
                  editingIsCategory || creatingCategory
                    ? "مثال: شكاوى الخدمات"
                    : "مثال: شكاوى الانتظار"
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cls-desc">الوصف</Label>
              <Textarea
                id="cls-desc"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="وصف موجز"
                rows={2}
              />
            </div>

            {!editingIsCategory && (
              <>
                <div className="space-y-1.5">
                  <Label>الفئة</Label>
                  <Select
                    value={formParentId || "none"}
                    onValueChange={(v) => setFormParentId(v === "none" ? "" : v)}
                    disabled={Boolean(editing)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="— اختر الفئة —" />
                    </SelectTrigger>
                    <SelectContent>
                      {!editing && (
                        <SelectItem value="none">— اختر الفئة —</SelectItem>
                      )}
                      {categoryOptions
                        .filter((c) => c.id !== editing?.id)
                        .map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5">
                    <Palette className="h-3.5 w-3.5" />
                    اللون المميز
                  </Label>
                  <ColorPicker value={formColor} onChange={setFormColor} />
                </div>

                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5">
                    <Tags className="h-3.5 w-3.5" />
                    الكلمات المفتاحية
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    لن تُحفظ الكلمات حتى الضغط على «حفظ التغييرات». الإلغاء لا يكتب شيئاً.
                  </p>
                  <Tabs defaultValue="current" className="w-full">
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="current">الكلمات الحالية</TabsTrigger>
                      <TabsTrigger
                        value="imported"
                        disabled={!editing || !isClassificationNode(editing)}
                      >
                        القيم المستوردة من «تفصيل»
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="current" className="mt-3">
                      <KeywordInput
                        keywords={formKeywords}
                        onChange={setFormKeywords}
                      />
                    </TabsContent>
                    <TabsContent value="imported" className="mt-3">
                      {editing && isClassificationNode(editing) ? (
                        <ImportedDetailPicker
                          classificationId={editing.id}
                          existingKeywords={formKeywords}
                          onSelect={(values) => {
                            setFormKeywords((prev) => mergeKeywordsIntoDraft(prev, values));
                          }}
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          احفظ التصنيف الفرعي أولًا لاختيار قيم تفصيل.
                        </p>
                      )}
                    </TabsContent>
                  </Tabs>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">إلغاء</Button>
            </DialogClose>
            <Button onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {editing ? "حفظ التغييرات" : "إضافة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
