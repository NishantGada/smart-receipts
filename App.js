import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Platform,
  Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { colors, radii, shadows, spacing, typography } from './theme';
// Same engine the server runs. Sharing it means the amounts on screen are the
// amounts that get written — the UI cannot drift from the saved split.
import { computeReceipt, toCents, toDollars } from './shared/split';

const API = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8004';
const GEMINI_KEY = process.env.EXPO_PUBLIC_GOOGLE_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
// v1beta, not v1: JSON mode (responseMimeType) is only available on v1beta, and
// without it the model wraps its output in ```json fences.
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

const MODE_LABELS = { equal: 'Equal', shares: 'Shares', percent: 'Percent', exact: 'Exact' };
const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;

// --- api -------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(
      `Can't reach the server at ${API}. Is it running, and is your phone on the same Wi-Fi as the Mac?`
    );
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.errors) && data.errors.length ? `\n\n${data.errors.join('\n')}` : '';
    const err = new Error((data.error || `Request failed (${res.status})`) + detail);
    err.status = res.status;
    throw err;
  }
  return data;
}

const OCR_PROMPT = `You are an expert receipt parser. Extract ALL information from this receipt.

NOTE ON MULTIPLE IMAGES: If more than one image is provided, they together form ONE continuous receipt (e.g. a long receipt photographed in parts, top to bottom in the order shown). Merge all items across all images into a single combined output. Do NOT treat them as separate receipts.

CRITICAL RULES:
1. Look for QUANTITIES - if you see "5x Burger" it means 5 burgers, NOT 1
2. Extract the UNIT PRICE if shown, or calculate it from total/quantity
3. List each item with its quantity and individual price
4. Extract subtotal, tax, tip (if any), and total
5. Include refunded, voided and $0.00 lines as items with the price shown on the receipt - do not silently drop them
6. Validate: sum of all items should equal the receipt total

Return ONLY valid JSON (no markdown, no code blocks, no explanation):
{
  "items": [{"name": "string", "quantity": number, "unitPrice": number, "totalPrice": number}],
  "subtotal": number,
  "tax": number,
  "tip": number,
  "total": number,
  "currency": "USD"
}`;

async function runOcr(images) {
  const res = await fetch(
    `${GEMINI_API}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: OCR_PROMPT },
            ...images.map((img) => ({
              inline_data: { mime_type: 'image/jpeg', data: img.base64 },
            })),
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          // A five-image grocery receipt can run to 40+ items. The old 1000-token
          // cap truncated the JSON mid-object and surfaced as a parse error.
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gemini rejected the request');

  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('Gemini returned no result. Try again in a moment.');
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error('The receipt was too long to parse in one pass. Try fewer images at a time.');
  }

  const text = candidate.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error('Could not read the receipt. Try clearer photos.');
  }
  if (!Array.isArray(parsed.items) || !parsed.items.length) {
    throw new Error('No items found on that receipt.');
  }
  return parsed;
}

async function pickReceiptImages() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    Alert.alert('Permission needed', 'Access to your photos is required to upload a receipt.');
    return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 10,
    orderedSelection: true,
    quality: 0.8,
    base64: true,
  });
  return result.canceled ? null : result.assets;
}

// --- shared bits -----------------------------------------------------------

function Button({ label, onPress, variant = 'primary', disabled, loading, icon, style }) {
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(disabled || loading) }}
      style={({ pressed }) => [
        s.btn,
        isPrimary && s.btnPrimary,
        variant === 'secondary' && s.btnSecondary,
        isDanger && s.btnDanger,
        pressed && !disabled && s.btnPressed,
        (disabled || loading) && s.btnDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={isPrimary || isDanger ? colors.textInverse : colors.accent} />
      ) : (
        <>
          {icon ? (
            <Ionicons
              name={icon}
              size={16}
              color={isPrimary || isDanger ? colors.textInverse : colors.accent}
              style={{ marginRight: spacing.xs }}
            />
          ) : null}
          <Text style={[s.btnText, !(isPrimary || isDanger) && s.btnTextSecondary]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

function Header({ title, subtitle, onBack, right }) {
  return (
    <View style={s.header}>
      {onBack ? (
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" style={s.backBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={s.headerTitle} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={s.headerSub} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

function Empty({ icon, title, body }) {
  return (
    <View style={s.empty}>
      <Ionicons name={icon} size={34} color={colors.textSubtle} />
      <Text style={s.emptyTitle}>{title}</Text>
      {body ? <Text style={s.emptyBody}>{body}</Text> : null}
    </View>
  );
}

function Banner({ tone = 'error', children }) {
  const map = {
    error: [colors.errorMuted, colors.error, 'alert-circle'],
    warning: [colors.warningMuted, colors.warning, 'warning'],
    success: [colors.successMuted, colors.success, 'checkmark-circle'],
    info: [colors.accentMuted, colors.accent, 'information-circle'],
  };
  const [bg, fg, icon] = map[tone] || map.info;
  return (
    <View style={[s.banner, { backgroundColor: bg, borderColor: fg }]}>
      <Ionicons name={icon} size={16} color={fg} style={{ marginTop: 1 }} />
      <Text style={[s.bannerText, { color: fg }]}>{children}</Text>
    </View>
  );
}

// --- groups ----------------------------------------------------------------

function GroupsScreen({ onOpen }) {
  const [groups, setGroups] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setGroups(await api('/groups'));
    } catch (err) {
      setError(err.message);
      setGroups([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api('/groups', { method: 'POST', body: { name: name.trim() } });
      setName('');
      await load();
    } catch (err) {
      Alert.alert('Could not create group', err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = (group) => {
    Alert.alert(
      `Delete "${group.name}"?`,
      `This permanently deletes ${group.receipt_count} receipt${group.receipt_count === 1 ? '' : 's'} and everything this group remembers.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try { await api(`/groups/${group.id}`, { method: 'DELETE' }); await load(); }
            catch (err) { Alert.alert('Could not delete', err.message); }
          },
        },
      ]
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <Header title="Groups" subtitle="Who you split receipts with" />
      {error ? <View style={{ paddingHorizontal: spacing.lg }}><Banner tone="error">{error}</Banner></View> : null}

      <View style={s.addRow}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="New group name"
          placeholderTextColor={colors.textSubtle}
          style={s.input}
          returnKeyType="done"
          onSubmitEditing={add}
          accessibilityLabel="New group name"
        />
        <Button label="Add" onPress={add} disabled={!name.trim()} loading={busy} />
      </View>

      {groups === null ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.accent} />
      ) : groups.length === 0 && !error ? (
        <Empty icon="people-outline" title="No groups yet" body="Create one above, then add its members." />
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(g) => String(g.id)}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onOpen(item)}
              onLongPress={() => remove(item)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}`}
              style={({ pressed }) => [s.card, pressed && s.cardPressed]}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{item.name}</Text>
                <Text style={s.cardSub}>
                  {item.member_count} member{item.member_count === 1 ? '' : 's'} · {item.receipt_count} receipt{item.receipt_count === 1 ? '' : 's'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textSubtle} />
            </Pressable>
          )}
        />
      )}
      <Text style={s.hint}>Long-press a group to delete it</Text>
    </View>
  );
}

// --- one group: members, scan, history -------------------------------------

function GroupScreen({ group, onBack, onSplitReady, onOpenReceipt }) {
  const [members, setMembers] = useState([]);
  const [history, setHistory] = useState([]);
  const [name, setName] = useState('');
  const [stage, setStage] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [m, h] = await Promise.all([
        api(`/groups/${group.id}/members`),
        api(`/groups/${group.id}/receipts`),
      ]);
      setMembers(m); setHistory(h);
    } catch (err) { setError(err.message); }
  }, [group.id]);

  useEffect(() => { load(); }, [load]);

  const addMember = async () => {
    if (!name.trim()) return;
    try {
      await api(`/groups/${group.id}/members`, { method: 'POST', body: { name: name.trim() } });
      setName(''); await load();
    } catch (err) { Alert.alert('Could not add member', err.message); }
  };

  const removeMember = (m) => {
    Alert.alert(`Remove ${m.name}?`, 'Their past splits stay on saved receipts.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          try { await api(`/members/${m.id}`, { method: 'DELETE' }); await load(); }
          catch (err) { Alert.alert('Could not remove', err.message); }
        },
      },
    ]);
  };

  const scan = async () => {
    if (members.length === 0) {
      Alert.alert('Add members first', 'A receipt needs people to split between.');
      return;
    }
    const images = await pickReceiptImages();
    if (!images) return;
    try {
      setStage(`Reading ${images.length} image${images.length === 1 ? '' : 's'}…`);
      const ocr = await runOcr(images);
      setStage('Matching against past splits…');
      const session = await api(`/groups/${group.id}/receipts`, {
        method: 'POST',
        body: { ocr, image_count: images.length },
      });
      onSplitReady({ ...session, group, previewUri: images[0]?.uri });
    } catch (err) {
      Alert.alert('Could not process receipt', err.message);
    } finally {
      setStage(null);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <Header title={group.name} subtitle={`${members.length} member${members.length === 1 ? '' : 's'}`} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxxl }}>
        {error ? <Banner tone="error">{error}</Banner> : null}

        <Text style={s.sectionLabel}>Members</Text>
        <View style={s.chipWrap}>
          {members.map((m) => (
            <Pressable
              key={m.id}
              onLongPress={() => removeMember(m)}
              accessibilityRole="button"
              accessibilityLabel={`Member ${m.name}, long press to remove`}
              style={s.memberChip}
            >
              <Text style={s.memberChipText}>{m.name}</Text>
            </Pressable>
          ))}
          {members.length === 0 ? <Text style={s.muted}>Nobody yet — add someone below.</Text> : null}
        </View>

        <View style={s.addRow}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Add member"
            placeholderTextColor={colors.textSubtle}
            style={s.input}
            returnKeyType="done"
            onSubmitEditing={addMember}
            accessibilityLabel="Add member name"
          />
          <Button label="Add" onPress={addMember} disabled={!name.trim()} variant="secondary" />
        </View>

        <View style={s.divider} />

        {stage ? (
          <View style={s.stageBox}>
            <ActivityIndicator color={colors.accent} />
            <Text style={s.stageText}>{stage}</Text>
          </View>
        ) : (
          <Button label="Scan a receipt" icon="camera-outline" onPress={scan} />
        )}

        <Text style={[s.sectionLabel, { marginTop: spacing.xl }]}>History</Text>
        {history.length === 0 ? (
          <Empty icon="receipt-outline" title="No receipts yet" body="Scan one to get started." />
        ) : (
          history.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => onOpenReceipt(r.id)}
              accessibilityRole="button"
              accessibilityLabel={`Open receipt from ${new Date(r.created_at).toLocaleDateString()}`}
              style={({ pressed }) => [s.card, pressed && s.cardPressed]}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{fmt(r.billable_total)}</Text>
                <Text style={s.cardSub}>
                  {new Date(r.created_at).toLocaleDateString()} · {r.item_count} items
                  {r.refunded_count ? ` · ${r.refunded_count} refunded` : ''}
                  {r.complimentary_count ? ` · ${r.complimentary_count} free` : ''}
                </Text>
                {Number(r.billable_total) !== Number(r.printed_total) ? (
                  <Text style={s.cardNote}>printed {fmt(r.printed_total)}</Text>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textSubtle} />
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

// --- the per-item split editor ---------------------------------------------

function ItemCard({
  item, members, decision, onChange, expanded, onToggle, liveSplits, error,
  onRemove, isDuplicate, busy,
}) {
  const { status, mode, entries } = decision;
  const valueFor = (id) => {
    const e = entries.find((x) => String(x.member_id) === String(id));
    return e ? e.value : 0;
  };
  const setValue = (id, value) => {
    const rest = entries.filter((x) => String(x.member_id) !== String(id));
    onChange({ ...decision, entries: [...rest, { member_id: id, value }] });
  };
  const toggleMember = (id) => setValue(id, valueFor(id) > 0 ? 0 : 1);

  const setStatus = (next) => onChange({ ...decision, status: next });
  const setMode = (next) => {
    // Carry participants across a mode change, but reset the numbers, since a
    // share count is not a percentage and silently reusing it would be wrong.
    const participants = entries.filter((e) => Number(e.value) > 0).map((e) => e.member_id);
    const live = participants.length ? participants : members.map((m) => m.id);
    const seed =
      next === 'percent' ? Math.round((100 / live.length) * 100) / 100
      : next === 'exact' ? Math.round((Number(item.total_price) / live.length) * 100) / 100
      : 1;
    onChange({ ...decision, mode: next, entries: live.map((id) => ({ member_id: id, value: seed })) });
  };

  const statusChip =
    status === 'refunded' ? ['Refunded', colors.error, colors.errorMuted]
    : status === 'complimentary' ? ['Free', colors.success, colors.successMuted]
    : [MODE_LABELS[mode] || 'Equal', colors.accent, colors.accentMuted];

  const memory = item.suggested?.source === 'memory';

  return (
    <View style={[s.itemCard, error && s.itemCardError]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${fmt(item.total_price)}, ${statusChip[0]}`}
        style={s.itemHead}
      >
        <View style={{ flex: 1 }}>
          <Text style={s.itemName} numberOfLines={expanded ? 3 : 2}>{item.name}</Text>
          <View style={s.itemMetaRow}>
            <Text style={s.itemPrice}>{fmt(item.total_price)}</Text>
            {Number(item.quantity) > 1 ? <Text style={s.itemQty}>×{Number(item.quantity)}</Text> : null}
            <View style={[s.statusChip, { backgroundColor: statusChip[2] }]}>
              <Text style={[s.statusChipText, { color: statusChip[1] }]}>{statusChip[0]}</Text>
            </View>
            {memory && !expanded ? (
              <Ionicons name="bookmark" size={12} color={colors.textSubtle} style={{ marginLeft: spacing.xs }} />
            ) : null}
            {item.manual ? (
              <View style={[s.statusChip, { backgroundColor: colors.surface }]}>
                <Text style={[s.statusChipText, { color: colors.textMuted }]}>Added by hand</Text>
              </View>
            ) : null}
            {isDuplicate ? (
              <View style={[s.statusChip, { backgroundColor: colors.warningMuted }]}>
                <Text style={[s.statusChipText, { color: colors.warning }]}>Possible duplicate</Text>
              </View>
            ) : null}
          </View>
          {!expanded && status === 'billable' ? (
            <Text style={s.itemPreview} numberOfLines={1}>
              {liveSplits.length
                ? liveSplits.map((sp) => `${sp.name} ${fmt(sp.amount)}`).join('  ·  ')
                : 'nobody assigned'}
            </Text>
          ) : null}
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textSubtle} />
      </Pressable>

      {expanded ? (
        <View style={s.itemBody}>
          {memory ? (
            <Text style={s.memoryNote}>
              <Ionicons name="bookmark" size={11} color={colors.textSubtle} />{' '}
              Remembered from last time (used {item.suggested.times_used}×)
            </Text>
          ) : null}

          <View style={s.segment}>
            {[['billable', 'Split'], ['complimentary', 'Free'], ['refunded', 'Refunded']].map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => setStatus(key)}
                accessibilityRole="button"
                accessibilityState={{ selected: status === key }}
                style={[s.segmentBtn, status === key && s.segmentBtnActive]}
              >
                <Text style={[s.segmentText, status === key && s.segmentTextActive]}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {status !== 'billable' ? (
            <Text style={s.muted}>
              {status === 'refunded'
                ? 'Excluded from the bill. Still shown on the receipt for the record.'
                : 'Free item — costs nobody anything.'}
            </Text>
          ) : (
            <>
              <View style={s.segment}>
                {Object.entries(MODE_LABELS).map(([key, label]) => (
                  <Pressable
                    key={key}
                    onPress={() => setMode(key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: mode === key }}
                    style={[s.segmentBtn, mode === key && s.segmentBtnActive]}
                  >
                    <Text style={[s.segmentText, mode === key && s.segmentTextActive]}>{label}</Text>
                  </Pressable>
                ))}
              </View>

              {members.map((m) => {
                const raw = valueFor(m.id);
                const live = liveSplits.find((x) => String(x.member_id) === String(m.id));
                const included = Number(raw) > 0;
                return (
                  <View key={m.id} style={s.memberRow}>
                    {mode === 'equal' ? (
                      <Pressable
                        onPress={() => toggleMember(m.id)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: included }}
                        accessibilityLabel={`Include ${m.name}`}
                        style={s.checkRow}
                      >
                        <Ionicons
                          name={included ? 'checkbox' : 'square-outline'}
                          size={20}
                          color={included ? colors.accent : colors.textSubtle}
                        />
                        <Text style={s.memberName}>{m.name}</Text>
                      </Pressable>
                    ) : (
                      <>
                        <Text style={[s.memberName, { flex: 1 }]}>{m.name}</Text>
                        <TextInput
                          value={raw === 0 ? '' : String(raw)}
                          onChangeText={(t) => setValue(m.id, t === '' ? 0 : Number(t.replace(/[^0-9.]/g, '')) || 0)}
                          keyboardType="decimal-pad"
                          placeholder="0"
                          placeholderTextColor={colors.textSubtle}
                          style={s.numInput}
                          accessibilityLabel={`${m.name} ${mode} value`}
                        />
                        <Text style={s.unitHint}>{mode === 'percent' ? '%' : mode === 'exact' ? '$' : 'sh'}</Text>
                      </>
                    )}
                    <Text style={[s.memberAmount, !included && s.memberAmountOff]}>
                      {fmt(live?.amount || 0)}
                    </Text>
                  </View>
                );
              })}
            </>
          )}

          {error ? <Banner tone="error">{error}</Banner> : null}

          {isDuplicate ? (
            <Banner tone="warning">
              Another line on this receipt has the same name. If your photos overlapped,
              the OCR may have read it twice — remove whichever copy is extra.
            </Banner>
          ) : null}

          <Pressable
            onPress={onRemove}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.name} from this receipt`}
            style={({ pressed }) => [s.removeBtn, pressed && { opacity: 0.6 }]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.error} />
            ) : (
              <>
                <Ionicons name="trash-outline" size={15} color={colors.error} />
                <Text style={s.removeText}>Remove this line</Text>
              </>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Manual entry for a line the OCR missed entirely. */
function AddItemForm({ onAdd, busy }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');

  const priceNum = Number(price);
  const ready = name.trim() && price !== '' && Number.isFinite(priceNum) && priceNum >= 0;

  const submit = async () => {
    if (!ready) return;
    const ok = await onAdd({
      name: name.trim(),
      total_price: priceNum,
      quantity: Number(qty) > 0 ? Number(qty) : 1,
    });
    if (ok) { setName(''); setPrice(''); setQty(''); setOpen(false); }
  };

  if (!open) {
    return (
      <Button
        label="Add a missing item"
        icon="add-circle-outline"
        variant="secondary"
        onPress={() => setOpen(true)}
        style={{ marginTop: spacing.sm }}
      />
    );
  }

  return (
    <View style={s.addItemCard}>
      <Text style={s.sectionLabel}>Add a missing item</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Item name"
        placeholderTextColor={colors.textSubtle}
        style={s.input}
        accessibilityLabel="New item name"
      />
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <TextInput
          value={price}
          onChangeText={(t) => setPrice(t.replace(/[^0-9.]/g, ''))}
          placeholder="Price (total)"
          placeholderTextColor={colors.textSubtle}
          keyboardType="decimal-pad"
          style={[s.input, { flex: 2 }]}
          accessibilityLabel="New item total price"
        />
        <TextInput
          value={qty}
          onChangeText={(t) => setQty(t.replace(/[^0-9.]/g, ''))}
          placeholder="Qty 1"
          placeholderTextColor={colors.textSubtle}
          keyboardType="decimal-pad"
          style={[s.input, { flex: 1 }]}
          accessibilityLabel="New item quantity"
        />
      </View>
      <Text style={s.muted}>
        Enter the line total as printed. Leave price at 0 for a free item.
      </Text>
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button label="Cancel" variant="secondary" onPress={() => setOpen(false)} style={{ flex: 1 }} />
        <Button label="Add" onPress={submit} disabled={!ready} loading={busy} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const decisionFrom = (item) => ({
  status: item.suggested.status,
  mode: item.suggested.mode || 'equal',
  entries: (item.suggested.entries || []).map((e) => ({
    member_id: e.member_id,
    value: Number(e.value),
  })),
});

function SplitScreen({ session, onBack, onSaved }) {
  const { members, printed, receipt_id, group } = session;
  const [expanded, setExpanded] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyItem, setBusyItem] = useState(null);
  const [adding, setAdding] = useState(false);
  const [sessionDead, setSessionDead] = useState(null);

  // Items live in state, not props: overlapping photos produce duplicate lines
  // the user needs to delete, and OCR sometimes misses one entirely.
  const [items, setItems] = useState(session.items);

  const [decisions, setDecisions] = useState(() => {
    const init = {};
    for (const item of session.items) init[item.position] = decisionFrom(item);
    return init;
  });

  const setDecision = (position, next) =>
    setDecisions((prev) => ({ ...prev, [position]: next }));

  const removeItem = (item) => {
    Alert.alert(
      'Remove this line?',
      `"${item.name}" (${fmt(item.total_price)}) will be dropped from this receipt.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            // Drop it from the screen immediately. Asking to remove a line is
            // unambiguous, so it should never sit waiting on the network — and
            // if the server call fails we put it back.
            const snapshotItems = items;
            const snapshotDecisions = decisions;
            setItems((prev) => prev.filter((i) => i.position !== item.position));
            setDecisions((prev) => {
              const next = { ...prev };
              delete next[item.position];
              return next;
            });
            if (expanded === item.position) setExpanded(null);

            try {
              await api(`/receipts/${receipt_id}/items/${item.id}`, { method: 'DELETE' });
            } catch (err) {
              if (err.status === 410) {
                // The receipt itself is gone server-side; every other action on
                // this screen will fail too, so say that once instead of per item.
                setSessionDead(err.message);
              } else {
                setItems(snapshotItems);
                setDecisions(snapshotDecisions);
                Alert.alert('Could not remove', err.message);
              }
            }
          },
        },
      ]
    );
  };

  const addItem = async ({ name, quantity, total_price }) => {
    setAdding(true);
    try {
      const { item } = await api(`/receipts/${receipt_id}/items`, {
        method: 'POST',
        body: { name, quantity, total_price },
      });
      setItems((prev) => [...prev, item]);
      setDecisions((prev) => ({ ...prev, [item.position]: decisionFrom(item) }));
      setExpanded(item.position);
      return true;
    } catch (err) {
      if (err.status === 404 || err.status === 410) setSessionDead(err.message);
      else Alert.alert('Could not add item', err.message);
      return false;
    } finally {
      setAdding(false);
    }
  };

  // Same spelling twice on one receipt is the signature of overlapping photos.
  const duplicatePositions = useMemo(() => {
    const seen = new Map();
    const dupes = new Set();
    for (const i of items) {
      const key = i.name.trim().replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(key)) { dupes.add(seen.get(key)); dupes.add(i.position); }
      else seen.set(key, i.position);
    }
    return dupes;
  }, [items]);

  // Recomputed locally on every keystroke by the same engine the server uses.
  const computed = useMemo(
    () =>
      computeReceipt({
        members,
        printed: {
          subtotal_cents: toCents(printed.subtotal),
          tax_cents: toCents(printed.tax),
          tip_cents: toCents(printed.tip),
          total_cents: toCents(printed.total),
        },
        items: items.map((i) => ({
          position: i.position,
          name: i.name,
          total_price_cents: toCents(i.total_price),
          ...decisions[i.position],
        })),
      }),
    [items, members, printed, decisions]
  );

  // Attribute each engine error back to the item it came from, so it renders
  // on that card instead of as an anonymous list at the bottom.
  const errorFor = useMemo(() => {
    const map = {};
    for (const item of items) {
      const hit = computed.errors.find((e) => e.startsWith(`"${item.name}"`));
      if (hit) map[item.position] = hit.replace(`"${item.name}": `, '');
    }
    return map;
  }, [computed.errors, items]);

  const liveFor = (position) => {
    const line = computed.perItem.find((p) => p.position === position);
    const nameOf = new Map(members.map((m) => [String(m.id), m.name]));
    return (line?.splits || [])
      .filter((sp) => sp.amount_cents !== 0 || Number(sp.raw_value) > 0)
      .map((sp) => ({
        member_id: sp.member_id,
        name: nameOf.get(String(sp.member_id)) || '?',
        amount: toDollars(sp.amount_cents),
      }));
  };

  const t = computed.totals;
  const unresolved = Object.keys(errorFor).length;

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        items: items.map((i) => {
          const d = decisions[i.position];
          return {
            position: i.position,
            status: d.status,
            mode: d.mode,
            entries: d.status === 'billable' ? d.entries.filter((e) => Number(e.value) > 0) : [],
          };
        }),
      };
      const summary = await api(`/receipts/${receipt_id}/splits`, { method: 'PUT', body });
      onSaved(summary);
    } catch (err) {
      if (err.status === 404 || err.status === 410) setSessionDead(err.message);
      else Alert.alert('Could not save', err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Header
        title="Split by item"
        subtitle={`${items.length} items · ${group?.name || ''}`}
        onBack={onBack}
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxxl }} keyboardShouldPersistTaps="handled">
        {sessionDead ? (
          <View>
            <Banner tone="error">{sessionDead}</Banner>
            <Button label="Back to group" icon="arrow-back" onPress={onBack} />
          </View>
        ) : null}

        {items.filter((i) => i.suggested?.source === 'memory').length ? (
          <Banner tone="info">
            {items.filter((i) => i.suggested?.source === 'memory').length} of {items.length} items
            were prefilled from how you split them last time. Change any of them and the new
            split is what gets remembered.
          </Banner>
        ) : null}

        {computed.warnings.map((w, i) => <Banner key={i} tone="warning">{w}</Banner>)}

        {items.map((item) => (
          <ItemCard
            key={item.position}
            item={item}
            members={members}
            decision={decisions[item.position]}
            onChange={(next) => setDecision(item.position, next)}
            expanded={expanded === item.position}
            onToggle={() => setExpanded(expanded === item.position ? null : item.position)}
            liveSplits={liveFor(item.position)}
            error={errorFor[item.position]}
            onRemove={() => removeItem(item)}
            isDuplicate={duplicatePositions.has(item.position)}
            busy={busyItem === item.position}
          />
        ))}

        <AddItemForm onAdd={addItem} busy={adding} />

        <View style={s.totalsCard}>
          <Row label="Printed total" value={fmt(t.printed_total_cents / 100)} />
          {t.refunded_cents ? <Row label="Refunded" value={`−${fmt(t.refunded_cents / 100)}`} tone={colors.error} /> : null}
          {t.complimentary_cents ? <Row label="Complimentary" value={`−${fmt(t.complimentary_cents / 100)}`} tone={colors.success} /> : null}
          {t.tax_cents ? <Row label="Tax" value={fmt(t.tax_cents / 100)} /> : null}
          {t.tip_cents ? <Row label="Tip" value={fmt(t.tip_cents / 100)} /> : null}
          <View style={s.divider} />
          <Row label="Billable total" value={fmt(t.billable_total_cents / 100)} strong />
          <View style={s.divider} />
          {computed.perPerson.map((p) => (
            <Row key={p.member_id} label={p.name} value={fmt(p.total_cents / 100)} strong />
          ))}
        </View>

        {unresolved ? (
          <Banner tone="error">
            {unresolved} item{unresolved === 1 ? '' : 's'} need{unresolved === 1 ? 's' : ''} attention before this can be saved.
          </Banner>
        ) : null}

        <Button
          label={unresolved ? `Fix ${unresolved} item${unresolved === 1 ? '' : 's'}` : 'Save split'}
          icon={unresolved ? 'alert-circle-outline' : 'checkmark'}
          onPress={save}
          disabled={!!unresolved}
          loading={saving}
          style={{ marginTop: spacing.md }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Row({ label, value, strong, tone }) {
  return (
    <View style={s.row}>
      <Text style={[s.rowLabel, strong && s.rowStrong]}>{label}</Text>
      <Text style={[s.rowValue, strong && s.rowStrong, tone && { color: tone }]}>{value}</Text>
    </View>
  );
}

// --- saved receipt ---------------------------------------------------------

function ReceiptScreen({ receiptId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api(`/receipts/${receiptId}`).then(setData).catch((e) => setError(e.message));
  }, [receiptId]);

  if (error) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="Receipt" onBack={onBack} />
        <View style={{ padding: spacing.lg }}><Banner tone="error">{error}</Banner></View>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="Receipt" onBack={onBack} />
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.accent} />
      </View>
    );
  }

  const billable = data.per_person.reduce((sum, p) => sum + p.cents, 0);

  return (
    <View style={{ flex: 1 }}>
      <Header
        title={data.label || 'Receipt'}
        subtitle={new Date(data.created_at).toLocaleString()}
        onBack={onBack}
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxxl }}>
        <View style={s.totalsCard}>
          <Text style={s.sectionLabel}>Who owes what</Text>
          {data.per_person.map((p) => (
            <Row key={p.member_id} label={p.name} value={fmt(p.dollars)} strong />
          ))}
          <View style={s.divider} />
          <Row label="Billable total" value={fmt(billable / 100)} strong />
          <Row label="Printed total" value={fmt(data.printed.total)} />
        </View>

        <Text style={[s.sectionLabel, { marginTop: spacing.lg }]}>Items</Text>
        {data.items.map((i) => (
          <View key={i.id} style={s.itemCard}>
            <View style={s.itemHead}>
              <View style={{ flex: 1 }}>
                <Text style={s.itemName}>{i.name}</Text>
                <View style={s.itemMetaRow}>
                  <Text style={s.itemPrice}>{fmt(i.total_price)}</Text>
                  {i.status !== 'billable' ? (
                    <View style={[s.statusChip, { backgroundColor: i.status === 'refunded' ? colors.errorMuted : colors.successMuted }]}>
                      <Text style={[s.statusChipText, { color: i.status === 'refunded' ? colors.error : colors.success }]}>
                        {i.status === 'refunded' ? 'Refunded' : 'Free'}
                      </Text>
                    </View>
                  ) : (
                    <View style={[s.statusChip, { backgroundColor: colors.accentMuted }]}>
                      <Text style={[s.statusChipText, { color: colors.accent }]}>{MODE_LABELS[i.mode] || i.mode}</Text>
                    </View>
                  )}
                </View>
                {i.splits.filter((sp) => sp.cents !== 0).length ? (
                  <Text style={s.itemPreview}>
                    {i.splits.filter((sp) => sp.cents !== 0).map((sp) => `${sp.name} ${fmt(sp.dollars)}`).join('  ·  ')}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// --- summary after saving --------------------------------------------------

function SavedScreen({ summary, onDone }) {
  const t = summary.totals;
  return (
    <View style={{ flex: 1 }}>
      <Header title="Split saved" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <Banner tone="success">Saved. This group now remembers these splits for next time.</Banner>
        {summary.warnings?.map((w, i) => <Banner key={i} tone="warning">{w}</Banner>)}

        <View style={s.totalsCard}>
          {summary.per_person.map((p) => (
            <View key={p.member_id} style={s.bigRow}>
              <Text style={s.bigName}>{p.name}</Text>
              <Text style={s.bigAmount}>{fmt(p.total)}</Text>
            </View>
          ))}
          <View style={s.divider} />
          <Row label="Printed total" value={fmt(t.printed_total)} />
          {t.refunded ? <Row label="Refunded" value={`−${fmt(t.refunded)}`} tone={colors.error} /> : null}
          {t.complimentary ? <Row label="Complimentary" value={`−${fmt(t.complimentary)}`} tone={colors.success} /> : null}
          <Row label="Billable total" value={fmt(t.billable_total)} strong />
        </View>

        <Button label="Done" onPress={onDone} style={{ marginTop: spacing.lg }} />
      </ScrollView>
    </View>
  );
}

// --- root ------------------------------------------------------------------

export default function App() {
  const [nav, setNav] = useState({ name: 'groups' });

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      {nav.name === 'groups' ? (
        <GroupsScreen onOpen={(group) => setNav({ name: 'group', group })} />
      ) : nav.name === 'group' ? (
        <GroupScreen
          group={nav.group}
          onBack={() => setNav({ name: 'groups' })}
          onSplitReady={(session) => setNav({ name: 'split', session, group: nav.group })}
          onOpenReceipt={(receiptId) => setNav({ name: 'receipt', receiptId, group: nav.group })}
        />
      ) : nav.name === 'split' ? (
        <SplitScreen
          session={nav.session}
          onBack={() => setNav({ name: 'group', group: nav.group })}
          onSaved={(summary) => setNav({ name: 'saved', summary, group: nav.group })}
        />
      ) : nav.name === 'saved' ? (
        <SavedScreen summary={nav.summary} onDone={() => setNav({ name: 'group', group: nav.group })} />
      ) : (
        <ReceiptScreen receiptId={nav.receiptId} onBack={() => setNav({ name: 'group', group: nav.group })} />
      )}
    </SafeAreaView>
  );
}

// --- styles ----------------------------------------------------------------

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  backBtn: { marginLeft: -spacing.xs },
  headerTitle: { fontSize: typography.title, fontWeight: typography.weightBold, color: colors.text },
  headerSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },

  sectionLabel: {
    fontSize: typography.caption, fontWeight: typography.weightSemibold,
    color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },

  addRow: { flexDirection: 'row', gap: spacing.sm, padding: spacing.lg, alignItems: 'center' },
  input: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    fontSize: typography.body, color: colors.text, backgroundColor: colors.surface,
  },

  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radii.md,
  },
  btnPrimary: { backgroundColor: colors.accent, ...shadows.sm },
  btnSecondary: { backgroundColor: colors.accentMuted },
  btnDanger: { backgroundColor: colors.error },
  btnPressed: { opacity: 0.85 },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: colors.textInverse, fontSize: typography.body, fontWeight: typography.weightSemibold },
  btnTextSecondary: { color: colors.accent },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceElevated, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.lg, marginBottom: spacing.sm, ...shadows.sm,
  },
  cardPressed: { backgroundColor: colors.surface },
  cardTitle: { fontSize: typography.heading, fontWeight: typography.weightSemibold, color: colors.text },
  cardSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },
  cardNote: { fontSize: typography.small, color: colors.textSubtle, marginTop: 2 },

  itemCard: {
    backgroundColor: colors.surfaceElevated, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm, overflow: 'hidden',
  },
  itemCardError: { borderColor: colors.error },
  itemHead: { flexDirection: 'row', alignItems: 'flex-start', padding: spacing.md, gap: spacing.sm },
  itemName: { fontSize: typography.body, fontWeight: typography.weightMedium, color: colors.text },
  itemMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  itemPrice: { fontSize: typography.body, fontWeight: typography.weightSemibold, color: colors.text },
  itemQty: { fontSize: typography.caption, color: colors.textMuted },
  itemPreview: { fontSize: typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  itemBody: {
    paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
    paddingTop: spacing.md,
  },

  statusChip: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radii.pill },
  statusChipText: { fontSize: typography.small, fontWeight: typography.weightSemibold },

  memoryNote: { fontSize: typography.small, color: colors.textSubtle },

  removeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: spacing.xs, paddingVertical: spacing.sm, marginTop: spacing.xs,
    borderRadius: radii.md, backgroundColor: colors.errorMuted,
  },
  removeText: { color: colors.error, fontSize: typography.caption, fontWeight: typography.weightSemibold },

  addItemCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.lg, marginTop: spacing.sm, gap: spacing.sm,
  },

  segment: {
    flexDirection: 'row', backgroundColor: colors.surface,
    borderRadius: radii.md, padding: 2, gap: 2,
  },
  segmentBtn: { flex: 1, paddingVertical: spacing.sm, borderRadius: radii.sm, alignItems: 'center' },
  segmentBtnActive: { backgroundColor: colors.surfaceElevated, ...shadows.sm },
  segmentText: { fontSize: typography.caption, color: colors.textMuted, fontWeight: typography.weightMedium },
  segmentTextActive: { color: colors.text, fontWeight: typography.weightSemibold },

  memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 40 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  memberName: { fontSize: typography.body, color: colors.text },
  numInput: {
    width: 74, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm,
    paddingHorizontal: spacing.sm, paddingVertical: spacing.sm,
    fontSize: typography.body, color: colors.text, textAlign: 'right', backgroundColor: colors.surface,
  },
  unitHint: { fontSize: typography.caption, color: colors.textSubtle, width: 18 },
  memberAmount: {
    fontSize: typography.body, fontWeight: typography.weightSemibold,
    color: colors.text, width: 76, textAlign: 'right',
  },
  memberAmountOff: { color: colors.textSubtle, fontWeight: typography.weightRegular },

  memberChip: {
    backgroundColor: colors.accentMuted, borderRadius: radii.pill,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  memberChipText: { color: colors.accent, fontSize: typography.caption, fontWeight: typography.weightSemibold },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },

  totalsCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.lg, marginTop: spacing.md,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.xs },
  rowLabel: { fontSize: typography.body, color: colors.textMuted },
  rowValue: { fontSize: typography.body, color: colors.text },
  rowStrong: { fontWeight: typography.weightSemibold, color: colors.text },
  bigRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm },
  bigName: { fontSize: typography.heading, color: colors.text, fontWeight: typography.weightMedium },
  bigAmount: { fontSize: typography.title, color: colors.text, fontWeight: typography.weightBold },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.md },

  banner: {
    flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start',
    borderRadius: radii.md, borderWidth: 1, padding: spacing.md, marginBottom: spacing.sm,
  },
  bannerText: { flex: 1, fontSize: typography.caption, lineHeight: 18 },

  stageBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  stageText: { fontSize: typography.body, color: colors.textMuted },

  empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
  emptyTitle: { fontSize: typography.heading, fontWeight: typography.weightSemibold, color: colors.text },
  emptyBody: { fontSize: typography.caption, color: colors.textMuted, textAlign: 'center' },

  muted: { fontSize: typography.caption, color: colors.textMuted },
  hint: { fontSize: typography.small, color: colors.textSubtle, textAlign: 'center', paddingBottom: spacing.sm },
});
