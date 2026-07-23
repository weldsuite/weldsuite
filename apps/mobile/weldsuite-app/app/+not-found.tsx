import { Stack, Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not Found' }} />
      <View style={styles.container}>
        <Text style={styles.title}>404</Text>
        <Text style={styles.message}>This screen doesn't exist.</Text>
        <Link href="/(tabs)" style={styles.link}>
          Go to Dashboard
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    padding: 20,
  },
  title: {
    fontSize: 48,
    fontWeight: '300',
    color: '#000000',
    marginBottom: 8,
  },
  message: {
    fontSize: 16,
    color: '#666666',
    marginBottom: 24,
  },
  link: {
    fontSize: 16,
    color: '#000000',
    textDecorationLine: 'underline',
  },
});