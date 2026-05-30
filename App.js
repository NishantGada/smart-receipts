import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import { useRef, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { colors, radii, shadows, spacing, typography } from './theme';

function computeSplits(assignments, receipt) {
  const amountsByPerson = {};
  const itemsByPerson = {};
  const warnings = [];
  const seenItems = new Set();

  for (const { item: itemName, claims, remainingTo } of assignments || []) {
    const receiptItem = receipt.items.find(i => i.name === itemName);
    if (!receiptItem) {
      warnings.push(`Unknown item: ${itemName}`);
      continue;
    }
    if (seenItems.has(itemName)) {
      warnings.push(`Duplicate assignment for: ${itemName}`);
      continue;
    }
    seenItems.add(itemName);

    const qty = receiptItem.quantity;
    const validClaims = (claims || []).filter(c => c && c.person && (c.units || 0) > 0);
    const claimSum = validClaims.reduce((s, c) => s + c.units, 0);

    const unitsByPerson = {};
    if (claimSum > qty) {
      const scale = qty / claimSum;
      for (const c of validClaims) {
        unitsByPerson[c.person] = (unitsByPerson[c.person] || 0) + c.units * scale;
      }
    } else {
      for (const c of validClaims) {
        unitsByPerson[c.person] = (unitsByPerson[c.person] || 0) + c.units;
      }
      const leftover = qty - claimSum;
      if (leftover > 0) {
        if (remainingTo) {
          unitsByPerson[remainingTo] = (unitsByPerson[remainingTo] || 0) + leftover;
        } else {
          warnings.push(`${leftover} unit(s) of "${itemName}" unassigned`);
        }
      }
    }

    if (Object.keys(unitsByPerson).length === 0) {
      warnings.push(`No one assigned to "${itemName}"`);
      continue;
    }

    for (const [person, units] of Object.entries(unitsByPerson)) {
      const fraction = units / qty;
      const amount = receiptItem.totalPrice * fraction;
      amountsByPerson[person] = (amountsByPerson[person] || 0) + amount;
      if (!itemsByPerson[person]) itemsByPerson[person] = [];
      const qtyLabel = Number.isInteger(units) ? `${units}x` : `${units.toFixed(2)}x`;
      itemsByPerson[person].push(`${qtyLabel} ${receiptItem.name} ($${amount.toFixed(2)})`);
    }
  }

  for (const item of receipt.items) {
    if (!seenItems.has(item.name)) {
      warnings.push(`Unassigned item: ${item.name}`);
    }
  }

  // Spread tax + tip proportionally to each person's subtotal
  const subtotalAssigned = Object.values(amountsByPerson).reduce((s, a) => s + a, 0);
  const extra = (receipt.tax || 0) + (receipt.tip || 0);
  if (extra > 0 && subtotalAssigned > 0) {
    for (const person of Object.keys(amountsByPerson)) {
      amountsByPerson[person] += (amountsByPerson[person] / subtotalAssigned) * extra;
    }
  }

  const splits = Object.entries(amountsByPerson).map(([person, amount]) => ({
    person,
    amount: Math.round(amount * 100) / 100,
    items: itemsByPerson[person] || [],
  }));

  const total = splits.reduce((s, sp) => s + sp.amount, 0);

  return {
    splits,
    total: Math.round(total * 100) / 100,
    validation: {
      allItemsAssigned: warnings.length === 0,
      message: warnings.join('; '),
    },
  };
}

export default function App() {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [extractedData, setExtractedData] = useState(null);

  const [splitInstructions, setSplitInstructions] = useState('');
  const [splitResults, setSplitResults] = useState(null);

  const scrollViewRef = useRef(null);
  const textInputRef = useRef(null);

  const processReceipt = async () => {
    setLoading(true);

    try {
      const apiKey = process.env.EXPO_PUBLIC_GOOGLE_API_KEY;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: `You are an expert receipt parser. Extract ALL information from this receipt.

NOTE ON MULTIPLE IMAGES: If more than one image is provided, they together form ONE continuous receipt (e.g., a long receipt photographed in parts, top to bottom in the order shown). Merge all items across all images into a single combined output. Do NOT treat them as separate receipts.

CRITICAL RULES:
1. Look for QUANTITIES - if you see "5x Burger" it means 5 burgers, NOT 1
2. Extract the UNIT PRICE if shown, or calculate it from total/quantity
3. List each item with its quantity and individual price
4. Extract subtotal, tax, tip (if any), and total
5. Validate: sum of all items should equal the receipt total

Return ONLY valid JSON (no markdown, no code blocks, no explanation):
{
  "items": [{"name": "string", "quantity": number, "unitPrice": number, "totalPrice": number}],
  "subtotal": number,
  "tax": number,
  "tip": number,
  "total": number,
  "validation": {"matches": boolean, "discrepancy": number},
  "currency": "USD"
}`
              },
              ...images.map(img => ({
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: img.base64,
                },
              })),
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1000,
          }
        }),
      });

      const data = await response.json();
      console.log('Gemini Response:', data);

      if (data.candidates && data.candidates[0]) {
        const content = data.candidates[0].content.parts[0].text;
        console.log('Raw content:', content);

        // Clean up potential markdown formatting
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanContent);

        setExtractedData(parsed);
        console.log('Extracted data:', parsed);
      }
    } catch (error) {
      console.error('Error:', error);

      if (error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED')) {
        Alert.alert('Rate limit reached', 'Please wait a minute and try again. Free tier resets daily.');
      } else {
        Alert.alert('Processing failed', 'Could not process the receipt. Check the console for details.');
      }
    } finally {
      setLoading(false);
    }
  };

  const processSplit = async () => {
    setLoading(true);

    try {
      const apiKey = process.env.EXPO_PUBLIC_GOOGLE_API_KEY;

      const itemsList = extractedData.items
        .map((item, idx) => `${idx + 1}. "${item.name}" (qty: ${item.quantity})`)
        .join('\n');

      const prompt = `You parse natural-language split instructions into structured unit claims. DO NOT compute money or fractions — downstream code handles all math (including over-claim scaling and leftover allocation). Your only job: for each receipt item, list which people explicitly CLAIMED how many units, plus which single person (if any) absorbs the leftover.

RECEIPT ITEMS:
${itemsList}

SPLIT INSTRUCTIONS:
${splitInstructions}

OUTPUT MODEL — for each item on the receipt:
- "item": exact item name (copy verbatim from the receipt list)
- "claims": array of { "person": string, "units": number } — units each person explicitly claimed for this item
- "remainingTo": a single person string OR null — who absorbs any unclaimed units (or any user "remaining/rest on X" target)

HOW TO PARSE THE INSTRUCTIONS:
- "X on 1 burger" / "X on burger" / "X had a burger" → X claims 1 unit of burger
- "X on 2 pav bhaji" / "X had 2 pav bhaji" → X claims 2 units of pav bhaji
- "A, B, C on burger" → A claims 1, B claims 1, C claims 1 (each individually)
- "A, B, C on 2 burgers" → A claims 2, B claims 2, C claims 2
- "split/divided between A, B, C" → A claims 1, B claims 1, C claims 1 (downstream will scale if over-claim)
- "remaining/rest on X" → set remainingTo: "X" on every item that has unclaimed units AND on every item not mentioned at all elsewhere
- "except X" → claims listed for everyone EXCEPT X

CRITICAL RULES:
1. Output claims EVEN IF they sum to more than the item's available quantity. Do not pre-scale, do not pre-trim — downstream handles it.
2. Output claims EVEN IF they sum to less than the item's available quantity. Set remainingTo if a "remaining" person was specified; otherwise null.
3. For items NOT mentioned in the instructions at all: empty claims, and set remainingTo to the "remaining" person if specified, else null.
4. Every receipt item MUST appear EXACTLY ONCE in the assignments array.
5. Use EXACT item names from the receipt (copy verbatim, including capitalization and punctuation).

Return JSON only (no markdown, no code blocks):
{
  "assignments": [
    {
      "item": "<exact item name>",
      "claims": [
        { "person": "Name1", "units": 1 },
        { "person": "Name2", "units": 1 }
      ],
      "remainingTo": "Name3" // or null
    }
  ]
}`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.05,
            maxOutputTokens: 2500,
          }
        }),
      });

      const data = await response.json();
      console.log('Split Response:', data);

      if (data.candidates && data.candidates[0]) {
        const content = data.candidates[0].content.parts[0].text;
        console.log('Raw split content:', content);

        let cleanContent = content
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .replace(/^[^{]*/g, '')
          .replace(/[^}]*$/g, '')
          .trim();

        console.log('Cleaned content:', cleanContent);
        const parsed = JSON.parse(cleanContent);
        const computed = computeSplits(parsed.assignments, extractedData);

        if (Math.abs(computed.total - extractedData.total) > 0.05) {
          console.warn(`Warning: Computed total ($${computed.total.toFixed(2)}) doesn't match receipt ($${extractedData.total.toFixed(2)})`);
        }
        if (!computed.validation.allItemsAssigned) {
          console.warn(`Validation issues: ${computed.validation.message}`);
        }

        setSplitResults(computed);
        console.log('Split results:', computed);
        console.log('--- Final Splits ---');
        computed.splits.forEach((split) => {
          const itemsLabel = split.items?.length ? ` [${split.items.join(', ')}]` : '';
          console.log(`  ${split.person}: $${split.amount.toFixed(2)}${itemsLabel}`);
        });
        console.log(`  TOTAL: $${computed.total.toFixed(2)} (receipt: $${extractedData.total.toFixed(2)})`);
      }
    } catch (error) {
      console.error('Error processing split:', error);

      if (error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED')) {
        Alert.alert('Rate limit reached', 'Please wait a minute and try again.');
      } else {
        Alert.alert('Split failed', 'Try simpler instructions or check the console for details.');
      }
    } finally {
      setLoading(false);
    }
  };

  const pickImage = async () => {
    // Request permission
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (permissionResult.granted === false) {
      Alert.alert('Permission needed', 'Permission to access the gallery is required to upload a receipt.');
      return;
    }

    // Launch image picker
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      allowsMultipleSelection: true,
      selectionLimit: 5,
      orderedSelection: true,
      quality: 0.8,
      base64: true,
    });

    if (!result.canceled) {
      setImages(result.assets);
      console.log(`${result.assets.length} image(s) selected`);
    }
  };

  const dismissKeyboard = () => {
    Keyboard.dismiss();
  };

  const resetAll = () => {
    setImages([]);
    setExtractedData(null);
    setSplitInstructions('');
    setSplitResults(null);
  };

  useEffect(() => {
    const keyboardDidShowListener = Keyboard.addListener(
      'keyboardDidShow',
      () => {
        // Scroll to bottom when keyboard opens
        setTimeout(() => {
          scrollViewRef.current?.scrollToEnd({ animated: true });
        }, 100);
      }
    );

    return () => {
      keyboardDidShowListener.remove();
    };
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={dismissKeyboard}
        >

          {images.length === 0 && !extractedData && (
            <View style={styles.centerContent}>
              <Text style={styles.title}>Smart Receipt</Text>
              <Text style={styles.subtitle}>Snap a receipt. Split it naturally.</Text>
              <TouchableOpacity
                style={styles.buttonPrimary}
                onPress={pickImage}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Upload one or more receipt images"
                hitSlop={8}
              >
                <Ionicons name="cloud-upload-outline" size={18} color={colors.textInverse} />
                <Text style={styles.buttonPrimaryText}>Upload receipt</Text>
              </TouchableOpacity>
              <Text style={styles.uploadHint}>
                Pick multiple images in order if your receipt spans several photos.
              </Text>
            </View>
          )}

          {images.length > 0 && (
            <View style={styles.imageContainer}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.thumbnailStrip}
              >
                {images.map((img, idx) => (
                  <View key={img.uri ?? idx} style={styles.thumbnailWrapper}>
                    <Image source={{ uri: img.uri }} style={styles.thumbnail} />
                    {images.length > 1 && (
                      <View style={styles.thumbnailBadge}>
                        <Text style={styles.thumbnailBadgeText}>{idx + 1}</Text>
                      </View>
                    )}
                  </View>
                ))}
              </ScrollView>
              <View style={styles.imageStatus}>
                <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                <Text style={styles.imageStatusText}>
                  {images.length === 1 ? 'Receipt loaded' : `${images.length} parts loaded`}
                </Text>
              </View>
            </View>
          )}

          {images.length > 0 && !loading && (
            <TouchableOpacity
              style={[styles.buttonPrimary, styles.buttonSpaced]}
              onPress={processReceipt}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Process the uploaded receipt"
              hitSlop={8}
            >
              <Ionicons name="sparkles-outline" size={18} color={colors.textInverse} />
              <Text style={styles.buttonPrimaryText}>Process receipt</Text>
            </TouchableOpacity>
          )}

          {loading && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text style={styles.loadingText}>
                {extractedData ? 'Splitting bill…' : 'Reading receipt…'}
              </Text>
            </View>
          )}

          {extractedData && !loading && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Receipt details</Text>

              <View style={styles.itemsList}>
                {extractedData.items.map((item, index) => (
                  <View
                    key={index}
                    style={[
                      styles.itemRow,
                      index === extractedData.items.length - 1 && styles.itemRowLast,
                    ]}
                  >
                    <Text style={styles.itemName}>
                      {item.quantity > 1 ? `${item.quantity}× ` : ''}{item.name}
                    </Text>
                    <Text style={styles.itemPrice}>${item.totalPrice.toFixed(2)}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.totalsContainer}>
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Subtotal</Text>
                  <Text style={styles.totalValue}>${extractedData.subtotal.toFixed(2)}</Text>
                </View>
                {extractedData.tax > 0 && (
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>Tax</Text>
                    <Text style={styles.totalValue}>${extractedData.tax.toFixed(2)}</Text>
                  </View>
                )}
                {extractedData.tip > 0 && (
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>Tip</Text>
                    <Text style={styles.totalValue}>${extractedData.tip.toFixed(2)}</Text>
                  </View>
                )}
                <View style={[styles.totalRow, styles.finalTotal]}>
                  <Text style={styles.totalLabelBold}>Total</Text>
                  <Text style={styles.totalValueBold}>${extractedData.total.toFixed(2)}</Text>
                </View>
              </View>

              <View
                style={[
                  styles.validationRow,
                  extractedData.validation.matches ? styles.validationSuccessBg : styles.validationWarningBg,
                ]}
              >
                <Ionicons
                  name={extractedData.validation.matches ? 'checkmark-circle' : 'alert-circle'}
                  size={14}
                  color={extractedData.validation.matches ? colors.success : colors.warning}
                />
                <Text
                  style={
                    extractedData.validation.matches
                      ? styles.validationSuccessText
                      : styles.validationWarningText
                  }
                >
                  {extractedData.validation.matches
                    ? 'Math checks out'
                    : `$${Math.abs(extractedData.validation.discrepancy).toFixed(2)} discrepancy`}
                </Text>
              </View>
            </View>
          )}

          {extractedData && !splitResults && (
            <View style={styles.splitInputContainer}>
              <Text style={styles.sectionTitle}>How to split</Text>
              <Text style={styles.helperText}>
                Try: "bananas on Alex, rolls and bread on Beth, sauce split between Alex and Beth"
              </Text>

              <TextInput
                ref={textInputRef}
                style={styles.textInput}
                multiline
                numberOfLines={4}
                placeholder="Describe how to split the bill…"
                placeholderTextColor={colors.textSubtle}
                value={splitInstructions}
                onChangeText={setSplitInstructions}
                onFocus={() => {
                  setTimeout(() => {
                    scrollViewRef.current?.scrollToEnd({ animated: true });
                  }, 300);
                }}
              />

              <TouchableOpacity
                style={[
                  styles.buttonPrimary,
                  !splitInstructions.trim() && styles.buttonDisabled,
                ]}
                onPress={processSplit}
                disabled={!splitInstructions.trim()}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Split the bill using the instructions above"
                accessibilityState={{ disabled: !splitInstructions.trim() }}
                hitSlop={8}
              >
                <Ionicons name="git-branch-outline" size={18} color={colors.textInverse} />
                <Text style={styles.buttonPrimaryText}>Split bill</Text>
              </TouchableOpacity>
            </View>
          )}

          {splitResults && (
            <View style={styles.resultsContainer}>
              <Text style={styles.sectionTitle}>Split results</Text>

              {splitResults.splits.map((split, index) => (
                <View key={index} style={styles.personCard}>
                  <View style={styles.personCardHeader}>
                    <Text style={styles.personName}>{split.person}</Text>
                    <Text style={styles.personAmount}>${split.amount.toFixed(2)}</Text>
                  </View>
                  {split.items.length > 0 && (
                    <Text style={styles.personItems}>{split.items.join(' · ')}</Text>
                  )}
                </View>
              ))}

              <View style={styles.finalTotalResult}>
                <Text style={styles.totalLabelBold}>Total</Text>
                <Text style={styles.totalValueBold}>${splitResults.total.toFixed(2)}</Text>
              </View>

              <TouchableOpacity
                style={[styles.buttonSecondary, styles.buttonSpaced]}
                onPress={() => {
                  setSplitResults(null);
                  setSplitInstructions('');
                }}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Edit split instructions and recalculate"
                hitSlop={8}
              >
                <Ionicons name="refresh-outline" size={18} color={colors.accent} />
                <Text style={styles.buttonSecondaryText}>Split again</Text>
              </TouchableOpacity>
            </View>
          )}

          {(images.length > 0 || extractedData || splitResults) && !loading && (
            <TouchableOpacity
              style={styles.buttonGhost}
              onPress={resetAll}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Discard everything and start over with a new receipt"
              hitSlop={8}
            >
              <Ionicons name="close-outline" size={16} color={colors.textMuted} />
              <Text style={styles.buttonGhostText}>Start over</Text>
            </TouchableOpacity>
          )}

          <StatusBar style="dark" />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flexGrow: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xl,
  },
  centerContent: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Typography
  title: {
    fontSize: typography.display,
    fontWeight: typography.weightSemibold,
    color: colors.text,
    letterSpacing: -0.5,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: typography.body,
    color: colors.textMuted,
    marginBottom: spacing.xxl,
    textAlign: 'center',
  },
  sectionTitle: {
    fontSize: typography.heading,
    fontWeight: typography.weightSemibold,
    color: colors.text,
    marginBottom: spacing.md,
  },
  cardTitle: {
    fontSize: typography.heading,
    fontWeight: typography.weightSemibold,
    color: colors.text,
    marginBottom: spacing.lg,
  },
  helperText: {
    fontSize: typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  uploadHint: {
    marginTop: spacing.lg,
    fontSize: typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    lineHeight: 18,
  },

  // Buttons
  buttonPrimary: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.lg,
    minWidth: 240,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    ...shadows.sm,
  },
  buttonPrimaryText: {
    color: colors.textInverse,
    fontSize: typography.body,
    fontWeight: typography.weightSemibold,
    letterSpacing: 0.2,
  },
  buttonSecondary: {
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 13,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.lg,
    minWidth: 240,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  buttonSecondaryText: {
    color: colors.accent,
    fontSize: typography.body,
    fontWeight: typography.weightSemibold,
    letterSpacing: 0.2,
  },
  buttonGhost: {
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  buttonGhostText: {
    color: colors.textMuted,
    fontSize: typography.caption,
    fontWeight: typography.weightMedium,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonSpaced: {
    marginTop: spacing.xl,
  },

  // Image strip
  imageContainer: {
    marginTop: spacing.xl,
    alignItems: 'center',
    width: '100%',
  },
  thumbnailStrip: {
    paddingHorizontal: spacing.xs,
  },
  thumbnailWrapper: {
    marginRight: spacing.md,
    position: 'relative',
  },
  thumbnail: {
    width: 140,
    height: 200,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    resizeMode: 'cover',
  },
  thumbnailBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: colors.text,
    borderRadius: radii.pill,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailBadgeText: {
    color: colors.textInverse,
    fontSize: 11,
    fontWeight: typography.weightSemibold,
  },
  imageStatus: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  imageStatusText: {
    fontSize: typography.caption,
    color: colors.textMuted,
    fontWeight: typography.weightMedium,
  },

  // Loading
  loadingContainer: {
    marginTop: spacing.xl,
    alignItems: 'center',
  },
  loadingText: {
    marginTop: spacing.md,
    fontSize: typography.caption,
    color: colors.textMuted,
    fontWeight: typography.weightMedium,
  },

  // Receipt details card
  card: {
    marginTop: spacing.xl,
    width: '100%',
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.xl,
  },
  itemsList: {
    marginBottom: spacing.lg,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  itemRowLast: {
    borderBottomWidth: 0,
  },
  itemName: {
    fontSize: typography.body,
    color: colors.text,
    flex: 1,
    marginRight: spacing.md,
  },
  itemPrice: {
    fontSize: typography.body,
    fontWeight: typography.weightMedium,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  totalsContainer: {
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  totalLabel: {
    fontSize: typography.body,
    color: colors.textMuted,
  },
  totalValue: {
    fontSize: typography.body,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  totalLabelBold: {
    fontSize: typography.body,
    fontWeight: typography.weightSemibold,
    color: colors.text,
  },
  totalValueBold: {
    fontSize: typography.heading,
    fontWeight: typography.weightSemibold,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  finalTotal: {
    marginTop: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderStrong,
  },
  validationRow: {
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  validationSuccessBg: {
    backgroundColor: colors.successMuted,
  },
  validationWarningBg: {
    backgroundColor: colors.warningMuted,
  },
  validationSuccessText: {
    fontSize: typography.caption,
    color: colors.success,
    fontWeight: typography.weightMedium,
  },
  validationWarningText: {
    fontSize: typography.caption,
    color: colors.warning,
    fontWeight: typography.weightMedium,
  },

  // Split input
  splitInputContainer: {
    marginTop: spacing.xl,
    width: '100%',
  },
  textInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    fontSize: typography.body,
    color: colors.text,
    minHeight: 110,
    textAlignVertical: 'top',
    backgroundColor: colors.surfaceElevated,
    marginBottom: spacing.lg,
    lineHeight: 22,
  },

  // Results
  resultsContainer: {
    marginTop: spacing.xl,
    width: '100%',
  },
  personCard: {
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  personCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  personName: {
    fontSize: typography.heading,
    fontWeight: typography.weightSemibold,
    color: colors.text,
  },
  personAmount: {
    fontSize: typography.title,
    fontWeight: typography.weightSemibold,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
  personItems: {
    marginTop: spacing.sm,
    fontSize: typography.caption,
    color: colors.textMuted,
    lineHeight: 18,
  },
  finalTotalResult: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: spacing.md,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.borderStrong,
  },
});