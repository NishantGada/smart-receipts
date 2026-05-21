import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import { useRef, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

export default function App() {
  const [image, setImage] = useState(null);
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
              {
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: image.base64
                }
              }
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

      const itemsList = extractedData.items.map(item =>
        `${item.name}|qty:${item.quantity}|unit:${item.unitPrice.toFixed(2)}|total:${item.totalPrice.toFixed(2)}`
      ).join('\n');

      const prompt = `Parse these split instructions and calculate exact amounts per person.
  
  RECEIPT ITEMS (format: name|qty:X|unit:$X|total:$X):
  ${itemsList}
  
  TOTAL RECEIPT: $${extractedData.total.toFixed(2)}
  
  INSTRUCTIONS:
  ${splitInstructions}
  
  STEPS TO FOLLOW:
  1. Extract all person names mentioned
  2. For each person, list their items:
     - Direct assignments: "X had Y" means X gets 1 Y
     - Quantities: "2 pav bhaji nirmit" means nirmit gets 2 pav bhaji
     - Equal splits: "divided between A, B, C" means divide total price by 3
     - Exclusions: "except X" means split among others only
  3. Calculate amounts using ONLY the unit/total prices provided above
  4. Each person appears ONCE in the output
  5. Sum all amounts - must equal receipt total
  
  EXAMPLE:
  If "burger divided between Amy and Bob":
  - Amy gets: 0.5 * burger_total
  - Bob gets: 0.5 * burger_total
  
  Return JSON only (no markdown):
  {
    "splits": [
      {"person": "Name", "items": ["1x Burger ($15.59)"], "amount": 15.59}
    ],
    "total": ${extractedData.total.toFixed(2)},
    "validation": {"allItemsAssigned": true, "message": ""}
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

        // Validation check
        const calculatedTotal = parsed.splits.reduce((sum, split) => sum + split.amount, 0);
        const receiptTotal = extractedData.total;

        if (Math.abs(calculatedTotal - receiptTotal) > 0.05) {
          console.warn(`Warning: Split total ($${calculatedTotal.toFixed(2)}) doesn't match receipt ($${receiptTotal.toFixed(2)})`);
        }

        setSplitResults(parsed);
        console.log('Split results:', parsed);
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
      quality: 0.8,
      base64: true,
    });

    if (!result.canceled) {
      setImage(result.assets[0]);
      console.log('Image selected:', result.assets[0].uri);
    }
  };

  const dismissKeyboard = () => {
    Keyboard.dismiss();
  };

  const resetAll = () => {
    setImage(null);
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

        <View style={!image && !extractedData ? styles.centerContent : null}>
          <Text style={styles.title}>Smart Receipt Splitter</Text>
          <TouchableOpacity style={styles.button} onPress={pickImage}>
            <Text style={styles.buttonText}>Upload Receipt</Text>
          </TouchableOpacity>
        </View>

        {image && (
          <View style={styles.imageContainer}>
            <Image
              source={{ uri: image.uri }}
              style={[
                styles.image,
                { aspectRatio: (image.width / image.height) || 1 },
              ]}
            />
            <Text style={styles.imageText}>Receipt loaded! ✅</Text>
          </View>
        )}

        {image && !loading && (
          <TouchableOpacity
            style={[styles.button, { marginTop: 20, backgroundColor: '#34C759' }]}
            onPress={processReceipt}
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
            >
              <Text style={styles.buttonText}>Split Again</Text>
            </TouchableOpacity>
          </View>
        )}

        {(image || extractedData || splitResults) && !loading && (
          <TouchableOpacity
            style={[styles.button, styles.startOverButton]}
            onPress={resetAll}
            activeOpacity={0.7}
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
    paddingHorizontal: 20,
  },
  image: {
    width: '100%',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  imageText: {
    marginTop: 10,
    fontSize: 16,
    color: '#007AFF',
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