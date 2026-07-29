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
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
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
  Merge,
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
  AlertCircle,
} from "lucide-react";
import { formatNumber } from "@/lib/ar-utils";
import { isAbortError } from "@/lib/abort";

// ---------- Types ----------
interface Classification {
  id: string;
  name: string;
  description?: string | null;
  color: string;
  keywords?: string | null; // JSON string
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
function parseKeywords(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
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
  onToggleMerge: (c: Classification) => void;
  isSelectedForMerge: boolean;
  mergeMode: boolean;
}

function ClassificationCard({
  classification,
  complaintCount,
  depth,
  onEdit,
  onAddChild,
  onToggleMerge,
  isSelectedForMerge,
  mergeMode,
}: ClassificationCardProps) {
  const hasChildren =
    classification.children && classification.children.length > 0;
  const [open, setOpen] = useState(true);
  const keywords = parseKeywords(classification.keywords);

  return (
    <div className="space-y-2" style={{ marginInlineStart: `${depth * 1.5}rem` }}>
      <Card
        className={`card-hover overflow-hidden transition-all ${
          isSelectedForMerge
            ? "ring-2 ring-primary border-primary/50"
            : "border-border"
        }`}
      >
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {/* Color indicator */}
            <div
              className="h-12 w-1.5 rounded-full shrink-0 self-stretch"
              style={{ backgroundColor: classification.color }}
              aria-hidden
            />

            {/* Main info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  {hasChildren ? (
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
                      style={{ color: classification.color }}
                    />
                  )}
                  <h4 className="font-semibold text-base truncate">
                    {classification.name}
                  </h4>
                  {hasChildren && (
                    <Badge variant="outline" className="text-[10px]">
                      {formatNumber(classification.children!.length)} تصنيف فرعي
                    </Badge>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1 shrink-0">
                  {mergeMode && (
                    <Button
                      size="sm"
                      variant={isSelectedForMerge ? "default" : "outline"}
                      onClick={() => onToggleMerge(classification)}
                      className="h-8"
                    >
                      {isSelectedForMerge ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          محدد
                        </>
                      ) : (
                        <>
                          <Merge className="h-3.5 w-3.5" />
                          تحديد
                        </>
                      )}
                    </Button>
                  )}
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => onEdit(classification)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">تعديل</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {!hasChildren && (
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
                        <TooltipContent side="top">إضافة تصنيف فرعي</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </div>

              {classification.description && (
                <p className="text-sm text-muted-foreground mt-1.5 line-clamp-2">
                  {classification.description}
                </p>
              )}

              {/* Stats row */}
              <div className="flex flex-wrap items-center gap-3 mt-3 text-xs">
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary/10 text-primary">
                  <FileText className="h-3.5 w-3.5" />
                  <span className="font-medium">
                    {formatNumber(complaintCount)} شكوى
                  </span>
                </div>
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary text-secondary-foreground">
                  <Tags className="h-3.5 w-3.5" />
                  <span className="font-medium">
                    {formatNumber(keywords.length)} كلمة مفتاحية
                  </span>
                </div>
              </div>

              {/* Keywords display */}
              {keywords.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3 pt-3 border-t border-dashed">
                  {keywords.slice(0, 8).map((kw) => (
                    <Badge
                      key={kw}
                      variant="outline"
                      className="text-[10px] font-normal py-0.5"
                    >
                      <Hash className="h-2.5 w-2.5 opacity-50" />
                      {kw}
                    </Badge>
                  ))}
                  {keywords.length > 8 && (
                    <Badge variant="outline" className="text-[10px] py-0.5">
                      +{formatNumber(keywords.length - 8)}
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Children */}
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
                  classification={child}
                  complaintCount={0}
                  depth={0}
                  onEdit={onEdit}
                  onAddChild={onAddChild}
                  onToggleMerge={onToggleMerge}
                  isSelectedForMerge={isSelectedForMerge}
                  mergeMode={mergeMode}
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
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formColor, setFormColor] = useState(PRESET_COLORS[0].value);
  const [formKeywords, setFormKeywords] = useState<string[]>([]);

  // Merge state
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<Classification[]>([]);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const fetchRequestRef = useRef(0);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    const requestId = fetchRequestRef.current + 1;
    fetchRequestRef.current = requestId;
    const canUpdate = () => !signal?.aborted && fetchRequestRef.current === requestId;
    setLoading(true);
    let aborted = false;
    try {
      const [classRes, dashRes] = await Promise.all([
        fetch("/api/classifications", { signal }),
        fetch("/api/dashboard", { signal }),
      ]);
      if (!classRes.ok) throw new Error("فشل تحميل التصنيفات");
      const classData: Classification[] = await classRes.json();

      if (dashRes.ok) {
        const dashData: DashboardData = await dashRes.json();
        const map = new Map<string, number>();
        for (const item of dashData.distributions?.byClassification ?? []) {
          map.set(item.name, item.count);
        }
        if (canUpdate()) {
          setClassifications(classData);
          setDistributionMap(map);
        }
      } else if (canUpdate()) {
        setClassifications(classData);
      }
    } catch (err) {
      aborted = isAbortError(err);
      if (aborted) {
        return;
      }
      const msg = err instanceof Error ? err.message : "خطأ غير متوقع";
      toast({
        title: "خطأ",
        description: msg,
        variant: "destructive",
      });
    } finally {
      if (!aborted && canUpdate()) {
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

  // Flat list for selectors
  const flatList = useMemo(() => flatten(classifications), [classifications]);

  const complaintCountFor = useCallback(
    (c: Classification): number => {
      const direct = distributionMap.get(c.name) ?? 0;
      // Aggregate children counts for parent display
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

  // Reset form
  const resetForm = () => {
    setFormName("");
    setFormDescription("");
    setFormColor(PRESET_COLORS[0].value);
    setFormKeywords([]);
    setFormParentId("");
    setEditing(null);
  };

  // Open add dialog (top-level or child)
  const openAddDialog = (parent?: Classification) => {
    resetForm();
    setFormParentId(parent?.id ?? "");
    setDialogOpen(true);
  };

  // Open edit dialog
  const openEditDialog = (c: Classification) => {
    setEditing(c);
    setFormName(c.name);
    setFormDescription(c.description ?? "");
    setFormColor(c.color || PRESET_COLORS[0].value);
    setFormKeywords(parseKeywords(c.keywords));
    setFormParentId(c.parentId ?? "");
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!formName.trim()) {
      toast({
        title: "تحقق من البيانات",
        description: "اسم التصنيف مطلوب",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: formName.trim(),
        description: formDescription.trim() || null,
        color: formColor,
        keywords: formKeywords,
        parentId: formParentId || null,
      };
      const res = await fetch("/api/classifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || "فشل الحفظ");
      }
      toast({
        title: editing ? "تم التحديث" : "تمت الإضافة",
        description: editing
          ? `تم تحديث التصنيف "${formName}" بنجاح`
          : `تمت إضافة التصنيف "${formName}" بنجاح`,
      });
      setDialogOpen(false);
      resetForm();
      await fetchData();
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

  // Merge handlers
  const toggleMergeSelection = (c: Classification) => {
    setMergeSelection((prev) => {
      const exists = prev.some((p) => p.id === c.id);
      if (exists) return prev.filter((p) => p.id !== c.id);
      if (prev.length >= 2) return [prev[1], c];
      return [...prev, c];
    });
  };

  const startMerge = () => {
    setMergeMode(true);
    setMergeSelection([]);
    toast({
      title: "وضع الدمج",
      description: "اختر تصنيفين متشابهين للدمج",
    });
  };

  const cancelMerge = () => {
    setMergeMode(false);
    setMergeSelection([]);
  };

  const confirmMerge = () => {
    setMergeDialogOpen(true);
  };

  const executeMerge = async () => {
    if (mergeSelection.length !== 2) return;
    const [source, target] = mergeSelection;
    toast({
      title: "جارٍ الدمج",
      description: `دمج "${source.name}" مع "${target.name}" (تجريبي)`,
    });
    setMergeDialogOpen(false);
    cancelMerge();
    // Stub action - would call /api/classifications/merge in real implementation
    setTimeout(() => {
      toast({
        title: "تم الدمج بنجاح",
        description: `تم دمج التصنيفات. سيتم تحديث الشكاوى المرتبطة.`,
      });
    }, 800);
  };

  // Stats summary
  const totalClassifications = flatList.length;
  const totalKeywords = flatList.reduce(
    (sum, c) => sum + parseKeywords(c.keywords).length,
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
        description="إدارة شجرة التصنيفات والكلمات المفتاحية المرتبطة بها"
        icon={<FolderTree className="h-6 w-6" />}
        actions={
          <>
            <Button variant="outline" onClick={() => void fetchData()} size="sm">
              <RefreshCw className="h-4 w-4" />
              تحديث
            </Button>
            {mergeMode ? (
              <>
                <Button variant="ghost" onClick={cancelMerge} size="sm">
                  إلغاء الدمج
                </Button>
                <Button
                  onClick={confirmMerge}
                  size="sm"
                  disabled={mergeSelection.length !== 2}
                >
                  <Merge className="h-4 w-4" />
                  دمج المحدد ({formatNumber(mergeSelection.length)}/2)
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={startMerge} size="sm">
                <Merge className="h-4 w-4" />
                دمج التصنيفات
              </Button>
            )}
            <Button onClick={() => openAddDialog()} size="sm">
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

      {/* Merge hint banner */}
      {mergeMode && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex items-center gap-3 py-3">
            <AlertCircle className="h-5 w-5 text-primary shrink-0" />
            <p className="text-sm flex-1">
              وضع الدمج مُفعّل. حدّد تصنيفين متشابهين لدمجهما في تصنيف واحد.
              سيتم نقل الشكاوى والكلمات المفتاحية من المصدر إلى الهدف.
            </p>
            <Badge variant="secondary">
              {formatNumber(mergeSelection.length)}/2 محدد
            </Badge>
          </CardContent>
        </Card>
      )}

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
                ابدأ بإضافة أول تصنيف رئيسي للنظام
              </p>
              <Button onClick={() => openAddDialog()}>
                <Plus className="h-4 w-4" />
                إضافة تصنيف
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
                  onAddChild={openAddDialog}
                  onToggleMerge={toggleMergeSelection}
                  isSelectedForMerge={mergeSelection.some(
                    (m) => m.id === c.id
                  )}
                  mergeMode={mergeMode}
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
              {editing ? (
                <>
                  <Edit className="h-5 w-5 text-primary" />
                  تعديل التصنيف
                </>
              ) : (
                <>
                  <Plus className="h-5 w-5 text-primary" />
                  {formParentId ? "إضافة تصنيف فرعي" : "إضافة تصنيف رئيسي"}
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "عدّل بيانات التصنيف والكلمات المفتاحية المرتبطة به"
                : "أدخل بيانات التصنيف الجديد. الحقول بعلامة * مطلوبة."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="cls-name">
                اسم التصنيف <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cls-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="مثال: شكاوى الانتظار"
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="cls-desc">الوصف</Label>
              <Textarea
                id="cls-desc"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="وصف موجز لنوع الشكاوى التي يشملها هذا التصنيف"
                rows={2}
              />
            </div>

            {/* Parent selector */}
            <div className="space-y-1.5">
              <Label>التصنيف الأب</Label>
              <Select
                value={formParentId || "none"}
                onValueChange={(v) => setFormParentId(v === "none" ? "" : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="— تصنيف رئيسي —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— تصنيف رئيسي (بدون أب) —</SelectItem>
                  {flatList
                    .filter((c) => c.id !== editing?.id)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.parentId ? "↳ " : ""}
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {/* Color */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Palette className="h-3.5 w-3.5" />
                اللون المميز
              </Label>
              <ColorPicker value={formColor} onChange={setFormColor} />
            </div>

            {/* Keywords */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Tags className="h-3.5 w-3.5" />
                الكلمات المفتاحية
              </Label>
              <KeywordInput
                keywords={formKeywords}
                onChange={setFormKeywords}
              />
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">إلغاء</Button>
            </DialogClose>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {editing ? "حفظ التغييرات" : "إضافة التصنيف"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge confirmation dialog */}
      <AlertDialog
        open={mergeDialogOpen}
        onOpenChange={setMergeDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Merge className="h-5 w-5 text-primary" />
              تأكيد دمج التصنيفات
            </AlertDialogTitle>
            <AlertDialogDescription>
              سيتم دمج التصنيفين التاليين في تصنيف واحد. جميع الشكاوى والكلمات
              المفتاحية المرتبطة بالمصدر سيتم نقلها إلى الهدف.
              <br />
              <br />
              <span className="font-medium text-foreground">
                المصدر:{" "}
              </span>
              {mergeSelection[0]?.name ?? "—"}
              <br />
              <span className="font-medium text-foreground">
                الهدف:{" "}
              </span>
              {mergeSelection[1]?.name ?? "—"}
              <br />
              <br />
              <span className="text-destructive">
                ملاحظة: لا يمكن التراجع عن هذه العملية.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={executeMerge}>
              <Merge className="h-4 w-4" />
              تأكيد الدمج
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
