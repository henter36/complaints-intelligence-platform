"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, Loader2, RefreshCw, Search, Settings as SettingsIcon } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

type FacilityStatus = "ACTIVE" | "CLOSED";

export type ManagedFacility = {
  id: string;
  name: string;
  region: string | null;
  status: FacilityStatus;
  closedAt: string | null;
};

export function filterManagedFacilities(
  facilities: readonly ManagedFacility[],
  filters: { search: string; status: "all" | FacilityStatus; region: string }
): ManagedFacility[] {
  const needle = filters.search.trim().toLocaleLowerCase("ar-SA");
  return facilities.filter((facility) =>
    (!needle || facility.name.toLocaleLowerCase("ar-SA").includes(needle))
    && (filters.status === "all" || facility.status === filters.status)
    && (filters.region === "all" || facility.region === filters.region)
  );
}

function currentRiyadhDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export function displayDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function Settings() {
  const { toast } = useToast();
  const [facilities, setFacilities] = useState<ManagedFacility[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | FacilityStatus>("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [target, setTarget] = useState<ManagedFacility | null>(null);
  const [closedAt, setClosedAt] = useState(currentRiyadhDate);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState("");

  const loadFacilities = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/settings/facilities", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(payload, "تعذر تحميل قائمة السجون."));
      setFacilities((payload as { facilities: ManagedFacility[] }).facilities ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "تعذر تحميل قائمة السجون.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadFacilities);
  }, [loadFacilities]);

  const regions = useMemo(() =>
    [...new Set(facilities.flatMap((facility) => facility.region ? [facility.region] : []))]
      .sort((left, right) => left.localeCompare(right, "ar")),
  [facilities]);

  const visibleFacilities = useMemo(() => {
    return filterManagedFacilities(facilities, {
      search,
      status: statusFilter,
      region: regionFilter,
    });
  }, [facilities, regionFilter, search, statusFilter]);

  function openStatusDialog(facility: ManagedFacility): void {
    setTarget(facility);
    setClosedAt(currentRiyadhDate());
    setSaveError("");
  }

  async function saveStatus(): Promise<void> {
    if (!target) return;
    const nextStatus: FacilityStatus = target.status === "ACTIVE" ? "CLOSED" : "ACTIVE";
    setSavePending(true);
    setSaveError("");
    try {
      const response = await fetch(`/api/settings/facilities/${encodeURIComponent(target.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: nextStatus,
          closedAt: nextStatus === "CLOSED" ? closedAt : null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(payload, "تعذر حفظ حالة السجن."));
      const updated = (payload as { facility: ManagedFacility }).facility;
      setFacilities((rows) => rows.map((row) => row.id === updated.id ? updated : row));
      setTarget(null);
      toast({
        title: "تم حفظ الحالة",
        description: `${updated.name}: ${updated.status === "ACTIVE" ? "نشط" : "مقفل"}`,
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "تعذر حفظ حالة السجن.");
    } finally {
      setSavePending(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="الإعدادات"
        description="إدارة المراجع التشغيلية المستخدمة في التحليلات والتقارير."
        icon={<SettingsIcon className="h-6 w-6" />}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            إدارة السجون
          </CardTitle>
          <CardDescription>
            السجون المقفلة تبقى بياناتها محفوظة، وتُستبعد زمنيًا من النطاق التشغيلي وفق تاريخ الإغلاق.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="facility-search">البحث بالاسم</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="facility-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="pr-9"
                  placeholder="اسم السجن"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="facility-status-filter">الحالة</Label>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
                <SelectTrigger id="facility-status-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">الكل</SelectItem>
                  <SelectItem value="ACTIVE">نشط</SelectItem>
                  <SelectItem value="CLOSED">مقفل</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="facility-region-filter">المنطقة</Label>
              <Select value={regionFilter} onValueChange={setRegionFilter}>
                <SelectTrigger id="facility-region-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل المناطق</SelectItem>
                  {regions.map((region) => <SelectItem key={region} value={region}>{region}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {loading && (
            <output aria-label="جارٍ تحميل السجون" className="block space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </output>
          )}

          {!loading && loadError && (
            <Alert variant="destructive">
              <AlertTitle>تعذر تحميل السجون</AlertTitle>
              <AlertDescription className="gap-3">
                <p>{loadError}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void loadFacilities()}>
                  <RefreshCw className="h-4 w-4" /> إعادة المحاولة
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {!loading && !loadError && visibleFacilities.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              لا توجد سجون مطابقة للفلاتر الحالية.
            </p>
          )}

          {!loading && !loadError && visibleFacilities.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">السجن</TableHead>
                  <TableHead className="text-right">المنطقة</TableHead>
                  <TableHead className="text-right">الحالة</TableHead>
                  <TableHead className="text-right">تاريخ الإغلاق</TableHead>
                  <TableHead className="text-right">الإجراء</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleFacilities.map((facility) => (
                  <TableRow key={facility.id}>
                    <TableCell className="font-medium">{facility.name}</TableCell>
                    <TableCell>{facility.region ?? "غير محدد"}</TableCell>
                    <TableCell>
                      <Badge variant={facility.status === "ACTIVE" ? "default" : "secondary"}>
                        {facility.status === "ACTIVE" ? "نشط" : "مقفل"}
                      </Badge>
                    </TableCell>
                    <TableCell>{displayDate(facility.closedAt)}</TableCell>
                    <TableCell>
                      <Button type="button" variant="outline" size="sm" onClick={() => openStatusDialog(facility)}>
                        تغيير الحالة
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={target !== null} onOpenChange={(open) => !open && !savePending && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{target?.status === "ACTIVE" ? "تأكيد إغلاق السجن" : "تأكيد إعادة تفعيل السجن"}</DialogTitle>
            <DialogDescription>
              {target?.status === "ACTIVE"
                ? "سيتم استبعاد هذا السجن من التحليلات والحسابات للفترات اللاحقة لتاريخ إغلاقه، مع الاحتفاظ بجميع بياناته وشكاواه السابقة."
                : "سيعود السجن إلى النطاق التشغيلي الحالي، وسيتم مسح تاريخ الإغلاق."}
            </DialogDescription>
          </DialogHeader>
          {target && (
            <div className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-md bg-muted/50 p-4 text-sm">
                <dt className="text-muted-foreground">السجن</dt><dd className="font-medium">{target.name}</dd>
                <dt className="text-muted-foreground">المنطقة</dt><dd>{target.region ?? "غير محدد"}</dd>
              </dl>
              {target.status === "ACTIVE" && (
                <div className="space-y-2">
                  <Label htmlFor="facility-closed-at">تاريخ الإغلاق</Label>
                  <Input
                    id="facility-closed-at"
                    type="date"
                    value={closedAt}
                    onChange={(event) => setClosedAt(event.target.value)}
                    required
                  />
                </div>
              )}
              {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTarget(null)} disabled={savePending}>
              إلغاء
            </Button>
            <Button
              type="button"
              onClick={() => void saveStatus()}
              disabled={savePending || (target?.status === "ACTIVE" && !closedAt)}
            >
              {savePending && <Loader2 className="h-4 w-4 animate-spin" />}
              {savePending ? "جارٍ الحفظ..." : "تأكيد تغيير الحالة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
