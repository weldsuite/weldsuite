import { View, ActivityIndicator } from 'react-native';

export default function SSOCallbackScreen() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
      <ActivityIndicator size="large" color="#E84C3D" />
    </View>
  );
}
