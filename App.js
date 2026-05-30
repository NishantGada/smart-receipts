import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import { useRef, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

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

        <View style={images.length === 0 && !extractedData ? styles.centerContent : null}>
          <Text style={styles.title}>Smart Receipt Splitter</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={pickImage}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Upload one or more receipt images"
            hitSlop={8}
          >
            <Text style={styles.buttonText}>Upload Receipt</Text>
          </TouchableOpacity>
          <Text style={styles.uploadHint}>
            Tip: pick multiple images in order if your receipt is split across photos
          </Text>
        </View>

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
            <Text style={styles.imageText}>
              {images.length === 1
                ? 'Receipt loaded! ✅'
                : `${images.length} parts loaded! ✅`}
            </Text>
          </View>
        )}

        {images.length > 0 && !loading && (
          <TouchableOpacity
            style={[styles.button, { marginTop: 20, backgroundColor: '#34C759' }]}
            onPress={processReceipt}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Process the uploaded receipt"
            hitSlop={8}
          >
            <Text style={styles.buttonText}>Process Receipt</Text>
          </TouchableOpacity>
        )}

        {loading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>
              {extractedData ? 'Splitting bill...' : 'Processing receipt...'}
            </Text>
          </View>
        )}

        {extractedData && !loading && (
          <View style={styles.extractedContainer}>
            <Text style={styles.sectionTitle}>Receipt Details</Text>

            <View style={styles.itemsList}>
              {extractedData.items.map((item, index) => (
                <View key={index} style={styles.itemRow}>
                  <Text style={styles.itemName}>
                    {item.quantity > 1 ? `${item.quantity}x ` : ''}{item.name}
                  </Text>
                  <Text style={styles.itemPrice}>${item.totalPrice.toFixed(2)}</Text>
                </View>
              ))}
            </View>

            <View style={styles.totalsContainer}>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Subtotal:</Text>
                <Text style={styles.totalValue}>${extractedData.subtotal.toFixed(2)}</Text>
              </View>
              {extractedData.tax > 0 && (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Tax:</Text>
                  <Text style={styles.totalValue}>${extractedData.tax.toFixed(2)}</Text>
                </View>
              )}
              {extractedData.tip > 0 && (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Tip:</Text>
                  <Text style={styles.totalValue}>${extractedData.tip.toFixed(2)}</Text>
                </View>
              )}
              <View style={[styles.totalRow, styles.finalTotal]}>
                <Text style={styles.totalLabelBold}>Total:</Text>
                <Text style={styles.totalValueBold}>${extractedData.total.toFixed(2)}</Text>
              </View>
            </View>

            {extractedData.validation.matches ? (
              <Text style={styles.validationSuccess}>✅ Math checks out!</Text>
            ) : (
              <Text style={styles.validationError}>
                ⚠️ Discrepancy: ${Math.abs(extractedData.validation.discrepancy).toFixed(2)}
              </Text>
            )}
          </View>
        )}

        {extractedData && !splitResults && (
          <View style={styles.splitInputContainer}>
            <Text style={styles.sectionTitle}>How to Split?</Text>
            <Text style={styles.instructionText}>
              Example: "bananas on Alex, rolls and bread on Beth, sauce split between Alex and Beth"
            </Text>

            <TextInput
              ref={textInputRef}
              style={styles.textInput}
              multiline
              numberOfLines={4}
              placeholder="Enter split instructions..."
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
                styles.button,
                { backgroundColor: '#FF9500' },
                !splitInstructions.trim() && styles.buttonDisabled,
              ]}
              onPress={processSplit}
              disabled={!splitInstructions.trim()}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Split the bill using the instructions above"
              accessibilityState={{ disabled: !splitInstructions.trim() }}
              hitSlop={8}
            >
              <Text style={styles.buttonText}>Split Bill</Text>
            </TouchableOpacity>
          </View>
        )}

        {splitResults && (
          <View style={styles.resultsContainer}>
            <Text style={styles.sectionTitle}>Split Results</Text>

            {splitResults.splits.map((split, index) => (
              <View key={index} style={styles.personCard}>
                <Text style={styles.personName}>{split.person}</Text>
                <Text style={styles.personAmount}>${split.amount.toFixed(2)}</Text>
                {split.items.length > 0 && (
                  <Text style={styles.personItems}>
                    Items: {split.items.join(', ')}
                  </Text>
                )}
              </View>
            ))}

            <View style={styles.finalTotalResult}>
              <Text style={styles.totalLabelBold}>Total:</Text>
              <Text style={styles.totalValueBold}>${splitResults.total.toFixed(2)}</Text>
            </View>

            <TouchableOpacity
              style={[styles.button, { marginTop: 20, backgroundColor: '#666' }]}
              onPress={() => {
                setSplitResults(null);
                setSplitInstructions('');
              }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Edit split instructions and recalculate"
              hitSlop={8}
            >
              <Text style={styles.buttonText}>Split Again</Text>
            </TouchableOpacity>
          </View>
        )}

        {(images.length > 0 || extractedData || splitResults) && !loading && (
          <TouchableOpacity
            style={[styles.button, styles.startOverButton]}
            onPress={resetAll}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Discard everything and start over with a new receipt"
            hitSlop={8}
          >
            <Text style={styles.buttonText}>Start Over</Text>
          </TouchableOpacity>
        )}

        <StatusBar style="auto" />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#fff',
  },
  container: {
    flexGrow: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 20,
  },
  centerContent: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 30,
  },
  button: {
    backgroundColor: '#007AFF',
    padding: 15,
    borderRadius: 10,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  startOverButton: {
    marginTop: 20,
    backgroundColor: '#FF3B30',
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },

  // Image styles
  imageContainer: {
    marginTop: 20,
    alignItems: 'center',
    width: '100%',
  },
  thumbnailStrip: {
    paddingHorizontal: 10,
  },
  thumbnailWrapper: {
    marginRight: 10,
    position: 'relative',
  },
  thumbnail: {
    width: 140,
    height: 200,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    resizeMode: 'cover',
  },
  thumbnailBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: 'rgba(0, 122, 255, 0.9)',
    borderRadius: 12,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  imageText: {
    marginTop: 10,
    fontSize: 16,
    color: '#007AFF',
  },
  uploadHint: {
    marginTop: 12,
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingHorizontal: 20,
  },

  loadingContainer: {
    marginTop: 20,
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 10,
    fontSize: 16,
    color: '#666',
    fontStyle: 'italic',
  },

  // extracted information styles
  extractedContainer: {
    marginTop: 20,
    width: '100%',
    backgroundColor: '#f8f8f8',
    borderRadius: 10,
    padding: 15,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 15,
    textAlign: 'center',
  },
  itemsList: {
    marginBottom: 15,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  itemName: {
    fontSize: 14,
    flex: 1,
  },
  itemPrice: {
    fontSize: 14,
    fontWeight: '600',
  },
  totalsContainer: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 2,
    borderTopColor: '#ccc',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  totalLabel: {
    fontSize: 14,
    color: '#666',
  },
  totalValue: {
    fontSize: 14,
    color: '#666',
  },
  totalLabelBold: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  totalValueBold: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  finalTotal: {
    marginTop: 5,
    paddingTop: 10,
    borderTopWidth: 2,
    borderTopColor: '#000',
  },
  validationSuccess: {
    marginTop: 15,
    textAlign: 'center',
    color: '#34C759',
    fontSize: 16,
    fontWeight: '600',
  },
  validationError: {
    marginTop: 15,
    textAlign: 'center',
    color: '#FF3B30',
    fontSize: 16,
    fontWeight: '600',
  },

  // text input styles
  splitInputContainer: {
    marginTop: 20,
    width: '100%',
  },
  instructionText: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
    marginBottom: 10,
    textAlign: 'center',
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: 'top',
    backgroundColor: '#fff',
    marginBottom: 15,
  },

  // result styles
  resultsContainer: {
    marginTop: 20,
    width: '100%',
    backgroundColor: '#f0f9ff',
    borderRadius: 10,
    padding: 15,
  },
  personCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  personName: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 5,
  },
  personAmount: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#007AFF',
    marginBottom: 5,
  },
  personItems: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
  },
  finalTotalResult: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 15,
    paddingTop: 15,
    borderTopWidth: 2,
    borderTopColor: '#007AFF',
  },
});